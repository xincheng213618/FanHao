export function createComputerControlSettings(computerControlService) {
  const actions = computerControlService.actionDescriptors().map((action) => ({
    id: action.id,
    label: `${action.icon} ${action.label}`,
    kind: action.kind === "danger" ? "subtle" : action.id === "lock" ? "primary" : "subtle",
    confirm: action.confirm || "",
    busyLabel: "发送中",
    progressLabel: `正在发送“${action.label}”指令`
  }));

  return Object.freeze({
    schema: {
      sections: [{
        id: "computer-control",
        title: "电脑控制",
        description: "控制运行 FanHao 主服务的这台电脑。关机和重启在 Windows 上保留 60 秒取消时间。",
        actions
      }]
    },
    read() {
      const current = computerControlService.status();
      return {
        values: {},
        status: {
          fields: {},
          platform: current.platform,
          platformLabel: current.platformLabel,
          lastDispatch: current.lastDispatch
        }
      };
    },
    action(actionId) {
      return computerControlService.dispatch(actionId);
    }
  });
}
