export function createVerificationAdvisories(scope, { maxDetails = 8 } = {}) {
  const messages = [];

  return {
    check(condition, message) {
      if (!condition) messages.push(String(message));
      return condition;
    },
    flush() {
      if (messages.length === 0) return;
      console.warn(`[advisory:${scope}] ${messages.length} review suggestion(s)`);
      for (const message of messages.slice(0, maxDetails)) console.warn(`  - ${message}`);
      if (messages.length > maxDetails) console.warn(`  - ... ${messages.length - maxDetails} more`);
    }
  };
}
