package local.fanhao.library;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/** Frozen production manifest commit before atomic replacement; executable negative control. */
final class LegacyVisionManifestCommit {
  static void writeJson(File file, JSONObject value) throws Exception {
    File temporary = new File(file.getParentFile(), "." + file.getName() + ".tmp");
    try (FileOutputStream output = new FileOutputStream(temporary)) {
      output.write(value.toString(2).getBytes(StandardCharsets.UTF_8));
      output.getFD().sync();
    }
    if (file.exists() && !file.delete()) throw new IllegalStateException("无法更新探索存档");
    if (!temporary.renameTo(file)) throw new IllegalStateException("无法提交探索存档");
    file.getParentFile().setLastModified(System.currentTimeMillis());
  }
}
