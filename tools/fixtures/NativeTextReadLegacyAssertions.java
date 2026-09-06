// Method fragment inserted only into the immutable pre-fix diagnostic fixture.
// Each probe executes the frozen real method/helper, with a finite synthetic input.
  static void legacySafetyCheck(String mode) throws Exception {
    if (mode.equals("zero")) {
      AtomicInteger count = new AtomicInteger();
      InputStream zeros = new InputStream() {
        public int read() { return -1; }
        public int read(byte[] b, int o, int n) throws IOException { if (count.incrementAndGet() > 32) throw new IOException("finite legacy probe"); return 0; }
      };
      failure(() -> BoundedTextReader.read(zeros, 64));
      if (count.get() > 8) throw new AssertionError("legacy zero-read safety absent");
    } else if (mode.equals("overflow")) {
      Stream bytes = new Stream(new byte[100000]); failure(() -> BoundedTextReader.read(bytes, 64));
      if (bytes.position > 65) throw new AssertionError("legacy max-plus-one safety absent");
    } else if (mode.equals("inline-size")) {
      ReadHost host = new ReadHost(); Intent text = new Intent(Intent.ACTION_SEND); text.text = "中😀";
      Number size = (Number) host.readIntentText(text).get("sizeBytes");
      if (size.longValue() != 7) throw new AssertionError("legacy UTF8 byte-size safety absent");
    } else if (mode.equals("inline-limit")) {
      ReadHost host = new ReadHost(); Intent text = new Intent(Intent.ACTION_SEND); text.text = "x".repeat(65);
      if (!(failure(() -> host.readIntentText(text)) instanceof IllegalArgumentException)) throw new AssertionError("legacy inline-limit safety absent");
    } else if (mode.equals("consume-OOM")) {
      ReadHost host = new ReadHost(); Stream stream = new Stream(new byte[]{65}); stream.readFailure = new OutOfMemoryError("legacy probe");
      host.activity.resolver.input = stream; offer(host, uriIntent()); PluginCall call = new PluginCall();
      failure(() -> host.consumePendingTextFile(call)); host.activity.drain();
      if (call.settlements != 1) throw new AssertionError("legacy consume OOM settlement absent");
    } else if (mode.equals("scanned-OOM")) {
      ReadHost host = new ReadHost(); Stream stream = new Stream(new byte[]{65}); stream.readFailure = new OutOfMemoryError("legacy probe"); host.activity.resolver.input = stream;
      CountDownLatch done = new CountDownLatch(1); Thread.UncaughtExceptionHandler prior = Thread.getDefaultUncaughtExceptionHandler();
      Thread.setDefaultUncaughtExceptionHandler((thread,error)->done.countDown());
      PluginCall call = new PluginCall();
      try { host.readScannedTextFile(call); if (!done.await(2, TimeUnit.SECONDS)) throw new AssertionError("legacy worker probe did not run"); }
      finally { Thread.setDefaultUncaughtExceptionHandler(prior); }
      host.activity.drain(); if (call.settlements != 1) throw new AssertionError("legacy scanned OOM settlement absent");
    } else throw new AssertionError("unknown historical probe");
  }
