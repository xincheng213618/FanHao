import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Execute the actual Activity decode/sampling/scale methods. HTTP and Android
// bitmap objects are controlled doubles: huge dimensions allocate no pixels,
// access no network/device, and still cross the real loadBitmap call chain.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const activity = fs.readFileSync(path.join(root,
  "android-client/android/app/src/main/java/local/fanhao/library/NativeShortVideoActivity.java"), "utf8").replace(/\r\n/g, "\n");
function member(name) {
  const start = new RegExp(`^  private [^\\n]* ${name}\\([^\\n]*`, "m").exec(activity);
  assert(start, `actual Activity method ${name}`);
  const first = activity.indexOf("{", start.index);
  let end = first + 1, depth = 1;
  for (; end < activity.length && depth; end++) {
    if (activity[end] === "{") depth++;
    else if (activity[end] === "}") depth--;
  }
  assert.equal(depth, 0, `complete Activity method ${name}`);
  return activity.slice(start.index, end);
}
const methods = ["loadBitmap", "bitmapSampleSize", "scaleBitmapToFit"].map(member).join("\n");
const javaHome = process.env.JAVA_HOME || "C:/Program Files/Android/openjdk/jdk-21.0.8";
const javac = path.join(javaHome, "bin", "javac.exe");
const java = path.join(javaHome, "bin", "java.exe");
function compileAndRun(label, actualMethods) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `fanhao-bitmap-${label}-`));
  try {
    const source = path.join(temporary, "NativeBitmapDecodeHarness.java");
    fs.writeFileSync(source, `
import java.io.*;import java.net.*;
public final class NativeBitmapDecodeHarness {
  @interface Nullable {}
  static int inputWidth,inputHeight,lastSample,decodeCalls;
  static Bitmap decoded;
  static final class Bitmap {
    final int width,height;boolean recycled;
    Bitmap(int width,int height){this.width=width;this.height=height;}
    int getWidth(){return width;}int getHeight(){return height;}
    void recycle(){recycled=true;}
    static Bitmap createScaledBitmap(Bitmap source,int width,int height,boolean filter){
      check(width<=source.width&&height<=source.height,"scale must never upscale the decoded image");
      return new Bitmap(width,height);
    }
  }
  static final class BitmapFactory {
    static final class Options {boolean inJustDecodeBounds;int outWidth,outHeight,inSampleSize=1;}
    static Bitmap decodeByteArray(byte[] bytes,int offset,int length,Options options){
      decodeCalls++;
      if(options.inJustDecodeBounds){options.outWidth=inputWidth;options.outHeight=inputHeight;return null;}
      lastSample=options.inSampleSize;
      if(inputWidth<=0||inputHeight<=0)return null;
      check(lastSample>0,"positive decoder sample");
      decoded=new Bitmap(1+(inputWidth-1)/lastSample,1+(inputHeight-1)/lastSample);
      return decoded;
    }
  }
  static final class FixtureConnection extends HttpURLConnection {
    String accept;
    FixtureConnection(URL url){super(url);}
    public void setRequestProperty(String key,String value){super.setRequestProperty(key,value);if("Accept".equals(key))accept=value;}
    public void connect(){connected=true;}public void disconnect(){connected=false;}
    public boolean usingProxy(){return false;}
  }
  static final class NativeShortVideoImageLoader {
    static byte[] read(HttpURLConnection connection){
      check(connection instanceof FixtureConnection,"fixture HTTP handler prevents real network access");
      check(connection.getConnectTimeout()==5000&&connection.getReadTimeout()==8000,"decode keeps bounded HTTP timeouts");
      check("image/*".equals(((FixtureConnection)connection).accept),"image request accepted type");
      return new byte[]{1};
    }
  }
  ${actualMethods}
  static void check(boolean condition,String message){if(!condition)throw new AssertionError(message);}
  static void image(String label,int width,int height,int maxWidth,int maxHeight,int expectedSample){
    inputWidth=width;inputHeight=height;lastSample=0;decodeCalls=0;decoded=null;
    NativeBitmapDecodeHarness activity=new NativeBitmapDecodeHarness();
    check(activity.bitmapSampleSize(width,height,maxWidth,maxHeight)==expectedSample,label+" sample must match fitted image size");
    Bitmap output=activity.loadBitmap("http://bitmap.fixture/image",maxWidth,maxHeight);
    check(output!=null&&decodeCalls==2,label+" crosses actual bounds and pixel decodes");
    check(lastSample==expectedSample,label+" loadBitmap must pass sampling into the pixel decoder");
    check(decoded.width<=2L*maxWidth&&decoded.height<=2L*maxHeight,label+" decoded axes must be bounded before scaling");
    check((long)decoded.width*decoded.height<=4L*maxWidth*maxHeight,label+" decoded pixel allocation must fit the target budget");
    check(output.width<=maxWidth&&output.height<=maxHeight,label+" final image fits display box");
    double fit=Math.min(1d,Math.min(maxWidth/(double)width,maxHeight/(double)height));
    int wantedWidth=Math.max(1,(int)Math.round(width*fit));
    int wantedHeight=Math.max(1,(int)Math.round(height*fit));
    check(Math.abs(output.width-wantedWidth)<=1&&Math.abs(output.height-wantedHeight)<=1,label+" sampling preserves fitted display resolution");
    if(width<=maxWidth&&height<=maxHeight)check(output==decoded&&!decoded.recycled,label+" small image is kept without scaling");
    else if(output!=decoded)check(decoded.recycled,label+" replaced intermediate decode is recycled");
  }
  public static void main(String[] args)throws Exception{
    URL.setURLStreamHandlerFactory(protocol->"http".equals(protocol)?new URLStreamHandler(){
      protected URLConnection openConnection(URL url){return new FixtureConnection(url);}
    }:null);
    image("panorama",12000,800,720,1280,16);
    image("long portrait",720,20000,720,1280,8);
    image("landscape video cover",1920,1080,720,1280,2);
    image("portrait video cover",1080,1920,720,1280,1);
    image("large portrait",2160,3840,720,1280,2);
    image("square thumbnail",4096,4096,512,512,8);
    image("wide thumbnail",16000,512,512,512,16);
    image("tall thumbnail",512,16000,512,512,16);
    image("exact target",720,1280,720,1280,1);
    image("exact twice target",1440,2560,720,1280,2);
    image("near twice target",1439,2559,720,1280,1);
    image("small image",320,240,720,1280,1);
    image("maximum wide dimension",Integer.MAX_VALUE,1,720,1280,2097152);
    image("maximum tall dimension",1,Integer.MAX_VALUE,720,1280,1048576);
    image("maximum dimensions minimum target",Integer.MAX_VALUE,Integer.MAX_VALUE,1,1,1073741824);
    NativeBitmapDecodeHarness activity=new NativeBitmapDecodeHarness();
    int[][] invalid={{0,100,720,1280},{100,0,720,1280},{-1,100,720,1280},{100,-1,720,1280},
      {100,100,0,1280},{100,100,720,0},{100,100,-1,1280},{100,100,720,-1}};
    for(int[] bounds:invalid)check(activity.bitmapSampleSize(bounds[0],bounds[1],bounds[2],bounds[3])==1,"invalid bounds must not loop or divide by zero");
    inputWidth=-1;inputHeight=-1;
    check(activity.loadBitmap("http://bitmap.fixture/invalid",720,1280)==null,"invalid decode bounds remain a failed image");
    System.out.println("Native bitmap decode: 15 image cases and 9 invalid-bound checks passed");
  }
}
`);
    const compiled = spawnSync(javac, ["-encoding", "UTF-8", "-d", temporary, source], { encoding: "utf8", timeout: 30000 });
    assert.equal(compiled.status, 0, `${label} compilation failed: ${compiled.error || ""}\n${compiled.stdout}\n${compiled.stderr}`);
    const ran = spawnSync(java, ["-cp", temporary, "NativeBitmapDecodeHarness"], { encoding: "utf8", timeout: 15000 });
    assert(!ran.error, `${label} JVM failed or hung: ${ran.error}`);
    return ran;
  } finally {
    // The compiler writes only flat, default-package fixture files here.
    for (const entry of fs.readdirSync(temporary, { withFileTypes: true })) {
      assert(entry.isFile(), `unexpected non-file in isolated bitmap fixture: ${entry.name}`);
      fs.unlinkSync(path.join(temporary, entry.name));
    }
    fs.rmdirSync(temporary);
  }
}
const passed = compileAndRun("actual", methods);
assert.equal(passed.status, 0, `${passed.stdout}\n${passed.stderr}`);
process.stdout.write(passed.stdout);
const oldBothAxes = methods.replace(
  "width / (sample * 2L) >= maxWidth || height / (sample * 2L) >= maxHeight",
  "width / (sample * 2L) >= maxWidth && height / (sample * 2L) >= maxHeight");
assert.notEqual(oldBothAxes, methods, "old both-axis sampling negative control must mutate actual code");
const bypassSampling = methods.replace(
  "options.inSampleSize = bitmapSampleSize(bounds.outWidth, bounds.outHeight, maxWidth, maxHeight);",
  "options.inSampleSize = 1;");
assert.notEqual(bypassSampling, methods, "decoder delegation negative control must mutate actual code");
for (const [label, mutated] of [["old-both-axes", oldBothAxes], ["bypassed-sampling", bypassSampling]]) {
  const failed = compileAndRun(label, mutated);
  assert.notEqual(failed.status, 0, `${label} behavioral negative control survived`);
  assert.match(failed.stderr, /AssertionError: panorama .*sampl/, `${label} must fail the relevant sampling assertion`);
}
console.log("Native bitmap decode: 2 compiled behavioral negative controls rejected");
