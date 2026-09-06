export function requiresUserAccount(value) {
  const state = value?.payload || value || {};
  return state.accountLoginRequired === true || ["account-required", "expired-account"].includes(state.reason);
}

export function isServerAuthenticationError(error) {
  const status = Number(error?.statusCode || error?.status);
  return status === 401 || (status === 403 && requiresUserAccount(error)) || error?.code === "NATIVE_AUTH_UNAVAILABLE";
}

export function accountLoginMessage(value) {
  if (value?.code === "NATIVE_AUTH_UNAVAILABLE") return "无法读取手机保存的登录会话，请重试连接。";
  return requiresUserAccount(value)
    ? "此服务需要用户账号，请在用户中心登录或注册。"
    : "请在用户中心登录或注册，也可使用原访问密码连接。";
}
