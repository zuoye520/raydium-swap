import RaydiumSwap from './RaydiumSwap'
import { Transaction, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js'
import dotenv from 'dotenv';
dotenv.config();
const swap = async () => {
  // const baseMint = 'So11111111111111111111111111111111111111112' // e.g. SOLANA mint address
  // const quoteMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' // e.g. USDC mint address
  // const RPC_URL = 'https://api.mainnet-beta.solana.com'
  const executeSwap = true // Change to true to execute swap
  const useVersionedTransaction = true // Use versioned transaction
  const tokenAAmount = 0.000001 // e.g. 0.01 SOL -> B_TOKEN
  const baseMint = process.env.BASE_MINT
  const quoteMint = process.env.QUOTE_MINT
  const raydiumSwap = new RaydiumSwap(process.env.RPC_URL, process.env.WALLET_PRIVATE_KEY)
  console.log(`Raydium swap initialized`)

  // Loading with pool keys from https://api.raydium.io/v2/sdk/liquidity/mainnet.json
  await raydiumSwap.loadPoolKeys()
  console.log(`Loaded pool keys`)

  // Trying to find pool info in the json we loaded earlier and by comparing baseMint and tokenBAddress
  let poolInfo = raydiumSwap.findPoolInfoForTokens(baseMint, quoteMint)

  if (!poolInfo) poolInfo = await raydiumSwap.findRaydiumPoolInfo(baseMint, quoteMint)

  if (!poolInfo) {
    throw new Error("Couldn't find the pool info")
  }

  // console.log('Found pool info', poolInfo)

  for (let i = 0; i < 10000; i++) {
    try {
      const tx = await raydiumSwap.getSwapTransaction(
        quoteMint,
        tokenAAmount,
        poolInfo,
        0 * LAMPORTS_PER_SOL, // Prioritization fee, now set to (0.0005 SOL)
        useVersionedTransaction,
        'in',
        90 // Slippage
      )
      if (executeSwap) {
        const txid = useVersionedTransaction
          ? await raydiumSwap.sendVersionedTransaction(tx as VersionedTransaction)
          : await raydiumSwap.sendLegacyTransaction(tx as Transaction)
    
        console.log(`https://solscan.io/tx/${txid}`)
      } else {
        const simRes = useVersionedTransaction
          ? await raydiumSwap.simulateVersionedTransaction(tx as VersionedTransaction)
          : await raydiumSwap.simulateLegacyTransaction(tx as Transaction)
    
        console.log(simRes)
      }
    } catch (error) {
      console.error('error:',error)
    }
    
  }
  
}

swap()
swap()
// swap()