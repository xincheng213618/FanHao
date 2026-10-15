package local.fanhao.library;

import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.Charset;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.*;

/* PLUGIN_HOST */

// Uses actual JDK charset implementations, not fake decoders. All bytes are
// synthetic in-memory literals; no books or provider/file APIs are opened.
public final class NativeTextDecodingHarness {
  static int checks;
  static void check(boolean pass, String message) { if (!pass) throw new AssertionError(message); checks++; }
  static byte[] hex(String input) { return HexFormat.of().parseHex(input.replace(" ", "")); }
  static byte[] prefix(String prefix, byte[] content) {
    byte[] bom = hex(prefix), result = Arrays.copyOf(bom, bom.length + content.length);
    System.arraycopy(content, 0, result, bom.length, content.length); return result;
  }
  record Invalid(String name, String bytes, String legacyEncoding, String legacyText) {}
  static final List<Invalid> INVALID = List.of(
    new Invalid("utf8-bom-truncated-payload", "EF BB BF 41 E2 82", "utf-8-sig", "A\uFFFD"),
    new Invalid("utf8-bom-illegal-continuation", "EF BB BF 41 C3 28", "utf-8-sig", "A\uFFFD("),
    new Invalid("utf8-bom-surrogate", "EF BB BF ED A0 80", "utf-8-sig", "\uFFFD"),
    new Invalid("utf16le-odd-payload", "FF FE 41 00 FF", "utf-16le", "A\uFFFD"),
    new Invalid("utf16be-odd-payload", "FE FF 00 41 FF", "utf-16be", "A\uFFFD"),
    new Invalid("utf16le-unpaired-high", "FF FE 41 00 3D D8", "utf-16le", "A\uFFFD"),
    new Invalid("utf16le-unpaired-low", "FF FE 00 DC", "utf-16le", "\uFFFD"),
    new Invalid("utf16be-unpaired-high", "FE FF D8 00", "utf-16be", "\uFFFD"),
    new Invalid("utf16be-unpaired-low", "FE FF DC 00", "utf-16be", "\uFFFD"),
    new Invalid("gb18030-unfinished-lead", "41 81", "gb18030", "A\uFFFD"),
    new Invalid("gb18030-unfinished-four-byte", "41 81 30 81", "gb18030", "A\uFFFD"),
    new Invalid("gb18030-illegal-trail", "41 81 20", "gb18030", "A\uFFFD "),
    new Invalid("utf32le-bom", "FF FE 00 00 41 00 00 00", "utf-16le", "\u0000A\u0000")
  );
  static void legacyEvidence() {
    LegacyNativeTextDecoder decoder = new LegacyNativeTextDecoder();
    for (Invalid invalid : INVALID) {
      LegacyNativeTextDecoder.DecodedText result = decoder.decodeText(hex(invalid.bytes()));
      check(result.encoding.equals(invalid.legacyEncoding()) && result.text.equals(invalid.legacyText()),
        "legacy silently changes malformed/unsupported " + invalid.name() + ": " + result.encoding + "/" + result.text.codePoints().mapToObj(point -> String.format("U+%04X", point)).toList());
    }
    String text = "Chapter 1\r\n中文 😀\n";
    check(decoder.decodeText(text.getBytes(StandardCharsets.UTF_8)).text.equals(text), "legacy valid UTF8 baseline");
    check(decoder.decodeText(prefix("EF BB BF", text.getBytes(StandardCharsets.UTF_8))).text.equals(text), "legacy valid BOM UTF8 baseline");
    check(decoder.decodeText(prefix("FF FE", text.getBytes(StandardCharsets.UTF_16LE))).text.equals(text), "legacy valid UTF16LE baseline");
    check(decoder.decodeText(prefix("FE FF", text.getBytes(StandardCharsets.UTF_16BE))).text.equals(text), "legacy valid UTF16BE baseline");
    check(decoder.decodeText(text.getBytes(Charset.forName("GB18030"))).text.equals(text), "legacy valid GB18030 baseline");
    System.out.println("native-text-decoding-legacy: " + checks + " actual charset observations reproduced");
  }
  static void legacySafety(String name) {
    Invalid invalid = INVALID.stream().filter(item -> item.name().equals(name)).findFirst().orElseThrow();
    boolean rejected = false;
    try { new LegacyNativeTextDecoder().decodeText(hex(invalid.bytes())); }
    catch (IllegalArgumentException failure) { rejected = true; }
    check(rejected, "old decoder must reject malformed or unsupported input: " + name);
  }
  @FunctionalInterface interface UnsafeAction { void run() throws Exception; }
  static void reject(UnsafeAction action, String label) throws Exception {
    try { action.run(); }
    catch (IllegalArgumentException expected) {
      check(expected.getMessage() != null && !expected.getMessage().isBlank(), label + " has a readable rejection reason");
      return;
    }
    throw new AssertionError("must reject malformed/unsupported/oversized input: " + label);
  }
  static void decoded(byte[] bytes, String encoding, String text, String label) {
    byte[] before = bytes.clone();
    NativeTextDecoder.Result result;
    try { result = NativeTextDecoder.decode(bytes); }
    catch (RuntimeException failure) { throw new AssertionError("valid text must decode: " + label, failure); }
    check(result.encoding.equals(encoding) && result.text.equals(text), label + " exact text and encoding");
    check(Arrays.equals(before, bytes), label + " leaves source bytes unchanged");
  }
  static long sized(String text, long limit) {
    try { return NativeTextDecoder.utf8Size(text, limit); }
    catch (RuntimeException failure) { throw new AssertionError("valid scalar text must fit its stated UTF8 budget", failure); }
  }
  static void standardEncodings() {
    for (String text : List.of("", "ASCII\r\nChapter 1\n\t", "中文小说，标点。", "😀𐀀􏿿", "正文\uFFFD保留\uFEFF中间字符", "\uFEFF正文", "正文\u0000末尾")) {
      decoded(text.getBytes(StandardCharsets.UTF_8), text.startsWith("\uFEFF") ? "utf-8-sig" : "utf-8", text.startsWith("\uFEFF") ? text.substring(1) : text, "unmarked UTF8");
      decoded(prefix("EF BB BF", text.getBytes(StandardCharsets.UTF_8)), "utf-8-sig", text, "BOM UTF8");
      decoded(prefix("FF FE", text.getBytes(StandardCharsets.UTF_16LE)), "utf-16le", text, "BOM UTF16LE");
      decoded(prefix("FE FF", text.getBytes(StandardCharsets.UTF_16BE)), "utf-16be", text, "BOM UTF16BE");
    }
    decoded(hex("D6 D0 CE C4"), "gb18030", "中文", "known GB18030 Chinese bytes");
    decoded(hex("90 30 81 30"), "gb18030", "𐀀", "known GB18030 four-byte first supplementary scalar");
    for (String text : List.of("中文 😀\r\n全本", "正文\uFFFD保持原文", "正文\uFEFF保持中间字符"))
      decoded(text.getBytes(Charset.forName("GB18030")), "gb18030", text, "GB18030 roundtrip without replacement filtering");
    // A partial signature can also be a valid legacy-encoding character. No
    // unmarked UTF16 or arbitrary text/binary guessing is part of this decoder.
    decoded(hex("EF BB"), "gb18030", "锘", "partial UTF8 signature is valid GB18030");
    decoded(hex("41 00"), "utf-8", "A\u0000", "unmarked UTF16-looking bytes are not guessed");
    decoded(hex("00 41"), "utf-8", "\u0000A", "unmarked big-endian-looking bytes are not guessed");
    decoded(hex("C2 A2"), "utf-8", "¢", "valid UTF8 wins when both charsets accept bytes");
    decoded(hex("EF BF BD"), "utf-8", "\uFFFD", "literal encoded replacement character is valid input");
    decoded(hex("FF FE C3 A9"), "utf-16le", "\uA9C3", "explicit BOM controls decoding despite UTF8-shaped payload");
  }
  static void malformedEncodings() throws Exception {
    for (Invalid invalid : INVALID) reject(() -> NativeTextDecoder.decode(hex(invalid.bytes())), invalid.name());
    for (String bytes : List.of("00 00 FE FF 00 00 00 41", "00 00 FE FF", "FF FE 00 00",
      "EF BB BF D6 D0 CE C4", "EF BB BF C0 AF", "EF BB BF F4 90 80 80", "EF BB BF F5 80 80 80",
      "EF BB BF F0 80 80 80", "EF BB BF E0 80 80", "EF BB BF C1 BF", "FF FE 00 D8 41 00", "FE FF D8 00 00 41",
      "81 30", "81 30 81 20", "81 30 20 30", "FF", "FE", "81 7F"))
      reject(() -> NativeTextDecoder.decode(hex(bytes)), "malformed signature/payload " + bytes);
    reject(() -> NativeTextDecoder.decode(null), "null byte input");
    for (int value = 0x80; value <= 0xFF; value++) {
      byte[] invalidUtf8 = { (byte) 0xEF, (byte) 0xBB, (byte) 0xBF, (byte) value };
      reject(() -> NativeTextDecoder.decode(invalidUtf8), "every isolated non-ASCII UTF8 payload byte " + value);
    }
    // Exhaust the single UTF16 surrogate alphabet in both explicit byte orders.
    for (int value = 0xD800; value <= 0xDFFF; value++) {
      byte[] little = { (byte) 0xFF, (byte) 0xFE, (byte) value, (byte) (value >>> 8) };
      byte[] big = { (byte) 0xFE, (byte) 0xFF, (byte) (value >>> 8), (byte) value };
      reject(() -> NativeTextDecoder.decode(little), "unpaired LE surrogate " + value);
      reject(() -> NativeTextDecoder.decode(big), "unpaired BE surrogate " + value);
    }
    // Strict no-BOM fallback is a defined preference, not an encoding detector.
    byte[] ambiguous = hex("E2 82");
    String legacyText = Charset.forName("GB18030").newDecoder().onMalformedInput(CodingErrorAction.REPORT)
      .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(ambiguous)).toString();
    decoded(ambiguous, "gb18030", legacyText, "incomplete UTF8 that is valid GB is accepted as GB by policy");
  }
  static void utf8Sizing() throws Exception {
    for (String text : List.of("", "A", "é", "中", "😀", "A中é😀\r\n", "\u0000\uFFFD\uFEFF", "\uD7FF\uE000\uFFFF", "𐀀􏿿")) {
      long actual = text.getBytes(StandardCharsets.UTF_8).length;
      check(sized(text, Long.MAX_VALUE) == actual, "UTF8 size agrees with actual encoder for valid scalar text");
      check(sized(text, Math.max(1, actual)) == actual, "UTF8 size accepts exact inclusive positive limit");
      if (actual > 1) reject(() -> NativeTextDecoder.utf8Size(text, actual - 1), "one byte over size limit");
    }
    for (long limit : new long[] { 0, -1, Long.MIN_VALUE }) reject(() -> NativeTextDecoder.utf8Size("", limit), "nonpositive byte limit " + limit);
    reject(() -> NativeTextDecoder.utf8Size(null, 20), "null text");
    for (int scalar : new int[] { 0, 0x7F, 0x80, 0x7FF, 0x800, 0xD7FF, 0xE000, 0xFFFF, 0x10000, 0x1F600, 0x10FFFF }) {
      String text = new String(Character.toChars(scalar));
      int expected = scalar <= 0x7F ? 1 : scalar <= 0x7FF ? 2 : scalar <= 0xFFFF ? 3 : 4;
      check(sized(text, expected) == expected, "UTF8 codepoint width boundary " + scalar);
      if (expected > 1) reject(() -> NativeTextDecoder.utf8Size(text, expected - 1), "UTF8 boundary over limit " + scalar);
    }
    for (int value = 0xD800; value <= 0xDFFF; value++) {
      String isolated = Character.toString((char) value);
      reject(() -> NativeTextDecoder.utf8Size(isolated, 20), "isolated sizing surrogate " + value);
      reject(() -> NativeTextDecoder.utf8Size("A" + isolated + "B", 20), "embedded sizing surrogate " + value);
    }
    String repeated = "甲A😀é".repeat(4096);
    long expected = 10L * 4096;
    check(sized(repeated, expected) == expected, "accumulated mixed-width text size");
    reject(() -> NativeTextDecoder.utf8Size(repeated, expected - 1), "accumulated final-byte overflow");
    reject(() -> NativeTextDecoder.utf8Size(repeated, 1), "early size bound without allocating encoded array");
  }
  static void productionChecks() throws Exception {
    int before = checks;
    standardEncodings(); malformedEncodings(); utf8Sizing();
    /* PLUGIN_CHECKS */
    System.out.println("native-text-decoding: " + (checks - before) + " complete production decoder/UTF8-size checks passed");
  }
  public static void main(String[] arguments) throws Exception {
    if (arguments.length > 0) { legacySafety(arguments[0]); return; }
    legacyEvidence();
    productionChecks();
  }
}
