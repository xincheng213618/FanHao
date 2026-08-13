package local.fanhao.library;

/** Mutable presentation state around one validated, persisted pending delete job. */
final class NativeShortVideoDeleteSession {
  final NativeShortVideoPendingJob pendingJob;
  boolean recoverable;
  boolean recovering;
  boolean manualIntervention;
  boolean processRestartRequired;
  boolean statusLoaded;
  String error = "";

  NativeShortVideoDeleteSession(NativeShortVideoPendingJob pendingJob) {
    this.pendingJob = pendingJob;
  }

  NativeShortVideoDeleteSession update(NativeShortVideoDeleteJobState state) {
    recoverable = state.recoverable;
    recovering = false;
    statusLoaded = true;
    manualIntervention = state.manualInterventionRequired || (state.stalled && !state.recoverable);
    processRestartRequired = state.processRestartRequired;
    error = state.error;
    return this;
  }

  NativeShortVideoDeleteSession withKind(String kind) {
    if (pendingJob.kind.equals(kind)) return this;
    NativeShortVideoDeleteSession replacement = new NativeShortVideoDeleteSession(new NativeShortVideoPendingJob(
      pendingJob.jobId, pendingJob.apiBaseUrl, kind, pendingJob.cleanupPendingFiles
    ));
    replacement.recoverable = recoverable;
    replacement.recovering = recovering;
    replacement.manualIntervention = manualIntervention;
    replacement.processRestartRequired = processRestartRequired;
    replacement.statusLoaded = statusLoaded;
    replacement.error = error;
    return replacement;
  }

  String message() {
    String message = NativeShortVideoPendingJob.KIND_CLEANUP.equals(pendingJob.kind)
      ? "资料库记录已移除，正在安全清理" + (pendingJob.cleanupPendingFiles > 0 ? pendingJob.cleanupPendingFiles + " 个文件" : "文件")
        + "（任务 #" + pendingJob.jobId + "）"
      : "删除尚未生效，正在安全恢复（任务 #" + pendingJob.jobId + "）";
    if (manualIntervention) message += processRestartRequired
      ? "\n需要人工处理，请重启服务后再恢复。"
      : "\n需要人工处理，请人工检查后再恢复。";
    if (!error.isEmpty()) message += "\n" + error;
    return message;
  }
}
