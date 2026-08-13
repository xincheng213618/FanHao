package local.fanhao.library;

/** Retains the HTTP status and public server code for delete-job request failures. */
final class NativeShortVideoDeleteJobException extends Exception {
  static final String JOB_NOT_FOUND = "SHORT_VIDEO_DELETE_JOB_NOT_FOUND";

  final int statusCode;
  final String code;

  NativeShortVideoDeleteJobException(int statusCode, String code, String message) {
    super(message == null || message.trim().isEmpty() ? "删除恢复请求失败" : message.trim());
    this.statusCode = statusCode;
    this.code = code == null ? "" : code.trim();
  }

  static boolean isJobNotFound(Exception error) {
    return error instanceof NativeShortVideoDeleteJobException
      && ((NativeShortVideoDeleteJobException) error).statusCode == 404
      && JOB_NOT_FOUND.equals(((NativeShortVideoDeleteJobException) error).code);
  }
}
