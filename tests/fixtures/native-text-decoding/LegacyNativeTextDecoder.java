package local.fanhao.library;

import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.Charset;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;

// Frozen FanHaoNovelPlugin.decodeText before strict decoding. Only visibility and
// its surrounding host change; all decode branches and byte operations are exact.
final class LegacyNativeTextDecoder {
  DecodedText decodeText(byte[] bytes) {
    if (bytes.length >= 3 && (bytes[0] & 0xff) == 0xef && (bytes[1] & 0xff) == 0xbb && (bytes[2] & 0xff) == 0xbf) {
      return new DecodedText("utf-8-sig", new String(bytes, 3, bytes.length - 3, StandardCharsets.UTF_8));
    }
    if (bytes.length >= 2 && (bytes[0] & 0xff) == 0xff && (bytes[1] & 0xff) == 0xfe) {
      return new DecodedText("utf-16le", new String(bytes, 2, bytes.length - 2, Charset.forName("UTF-16LE")));
    }
    if (bytes.length >= 2 && (bytes[0] & 0xff) == 0xfe && (bytes[1] & 0xff) == 0xff) {
      return new DecodedText("utf-16be", new String(bytes, 2, bytes.length - 2, Charset.forName("UTF-16BE")));
    }
    try {
      String text = StandardCharsets.UTF_8
        .newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(bytes))
        .toString();
      return new DecodedText("utf-8", text);
    } catch (CharacterCodingException ignored) {
      return new DecodedText("gb18030", new String(bytes, Charset.forName("GB18030")));
    }
  }

  static final class DecodedText {
    final String encoding;
    final String text;
    DecodedText(String encoding, String text) { this.encoding = encoding; this.text = text; }
  }
}
