// Network settings. The app runs on Monad Testnet (free test money, no real cost).
window.APP_CONFIG = {
  network: {
    name: "Monad Testnet",
    chainId: 10143,
    rpcUrl: "https://testnet-rpc.monad.xyz",
    currency: "MON",
    explorer: "https://testnet.monadvision.com",
    faucet: "https://faucet.monad.xyz",
  },
  // MON the teacher sends to each new student so they can pay for their clicks.
  // Measured on Monad Testnet (Sept 2026): one "Mark me present" costs about 0.011 MON,
  // and the wallet must hold about 0.025 MON at the moment of clicking.
  gasPerStudent: "0.1",
  // Below this balance the page warns that the wallet is running low.
  lowBalance: "0.03",
  // How often (milliseconds) the class page refreshes itself.
  refreshEvery: 6000,
};
