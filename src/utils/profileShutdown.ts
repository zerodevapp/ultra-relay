// The CLI instrumentation module registers this hook without importing itself into request code.
export const profileShutdown: { flush?: () => Promise<void> } = {}
