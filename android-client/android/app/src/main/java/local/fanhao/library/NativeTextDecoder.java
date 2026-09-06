package local.fanhao.library;

import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.Charset;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;

/** Strict decoding for the text encodings supported by local novel import. */
final class NativeTextDecoder {
  static final class Result {
    final String encoding;
    final String text;

    Result(String encoding, String text) {
      this.encoding = encoding;
      this.text = text;
    }
  }

  static Result decode(byte[] bytes) {
    if (bytes == null) throw new IllegalArgumentException("无法读取文本内容");
    // Check UTF-32 first: its little-endian BOM also starts with the UTF-16 BOM.
    if (startsWith(bytes, 0xff, 0xfe, 0x00, 0x00) || startsWith(bytes, 0x00, 0x00, 0xfe, 0xff)) {
      throw new IllegalArgumentException("暂不支持 UTF-32 文本，请另存为 UTF-8 后导入");
    }
    try {
      if (startsWith(bytes, 0xef, 0xbb, 0xbf)) {
        return new Result("utf-8-sig", decodeStrict(bytes, 3, StandardCharsets.UTF_8));
      }
      if (startsWith(bytes, 0xff, 0xfe)) {
        return new Result("utf-16le", decodeStrict(bytes, 2, StandardCharsets.UTF_16LE));
      }
      if (startsWith(bytes, 0xfe, 0xff)) {
        return new Result("utf-16be", decodeStrict(bytes, 2, StandardCharsets.UTF_16BE));
      }
      try {
        return new Result("utf-8", decodeStrict(bytes, 0, StandardCharsets.UTF_8));
      } catch (CharacterCodingException notUtf8) {
        return new Result("gb18030", decodeStrict(bytes, 0, Charset.forName("GB18030")));
      }
    } catch (CharacterCodingException invalidText) {
      throw new IllegalArgumentException("文本编码不完整或不受支持，请另存为 UTF-8 后导入", invalidText);
    }
  }

  private static String decodeStrict(byte[] bytes, int offset, Charset charset) throws CharacterCodingException {
    return charset.newDecoder()
      .onMalformedInput(CodingErrorAction.REPORT)
      .onUnmappableCharacter(CodingErrorAction.REPORT)
      .decode(ByteBuffer.wrap(bytes, offset, bytes.length - offset))
      .toString();
  }

  private static boolean startsWith(byte[] bytes, int... prefix) {
    if (bytes.length < prefix.length) return false;
    for (int index = 0; index < prefix.length; index += 1) {
      if ((bytes[index] & 0xff) != prefix[index]) return false;
    }
    return true;
  }

  /** Count before allocating a UTF-8 byte array; never silently replace broken surrogates. */
  static long utf8Size(String text, long maximumBytes) {
    if (text == null) throw new IllegalArgumentException("无法读取文本内容");
    if (maximumBytes < 1L) throw new IllegalArgumentException("文本读取上限无效");
    long size = 0L;
    for (int index = 0; index < text.length(); index += 1) {
      char value = text.charAt(index);
      int width;
      if (Character.isHighSurrogate(value)) {
        if (index + 1 >= text.length() || !Character.isLowSurrogate(text.charAt(index + 1))) {
          throw new IllegalArgumentException("文本含不完整字符，请另存为 UTF-8 后导入");
        }
        index += 1;
        width = 4;
      } else if (Character.isLowSurrogate(value)) {
        throw new IllegalArgumentException("文本含不完整字符，请另存为 UTF-8 后导入");
      } else {
        width = value <= 0x7f ? 1 : value <= 0x7ff ? 2 : 3;
      }
      if (size > maximumBytes - width) {
        throw new IllegalArgumentException("文本文件太大，暂时只支持 80MB 以内");
      }
      size += width;
    }
    return size;
  }

  private NativeTextDecoder() {}
}
