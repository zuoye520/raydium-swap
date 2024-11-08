import {
    Connection,
    PublicKey,
    Keypair,
    Transaction,
    VersionedTransaction,
    TransactionMessage,
  } from '@solana/web3.js'
  import {
    Liquidity,
    jsonInfo2PoolKeys,
    TOKEN_PROGRAM_ID,
    Percent,
    SPL_ACCOUNT_LAYOUT,
    LIQUIDITY_STATE_LAYOUT_V4,
    MARKET_STATE_LAYOUT_V3,
    Market,
    Token,
    TokenAmount,
  } from '@raydium-io/raydium-sdk'
  import { Wallet } from '@project-serum/anchor'
  import base58 from 'bs58'
  import { existsSync } from 'fs'
  import { readFile, writeFile } from 'fs/promises'
  
  class RaydiumSwap {
    static RAYDIUM_V4_PROGRAM_ID = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8'
  
    constructor(RPC_URL, WALLET_PRIVATE_KEY) {
      this.connection = new Connection(RPC_URL, { commitment: 'confirmed' })
      this.wallet = new Wallet(Keypair.fromSecretKey(base58.decode(WALLET_PRIVATE_KEY)))
    }
  
    async loadPoolKeys() {
      try {
        if (existsSync('pools.json')) {
          this.allPoolKeysJson = JSON.parse((await readFile('pools.json')).toString())
          return
        }
  
        throw new Error('no file found')
      } catch (error) {
        const liquidityJsonResp = await fetch('https://api.raydium.io/v2/sdk/liquidity/mainnet.json')
        if (!liquidityJsonResp.ok) return []
        const liquidityJson = await liquidityJsonResp.json()
        const allPoolKeysJson = [...(liquidityJson?.official ?? []), ...(liquidityJson?.unOfficial ?? [])]
  
        this.allPoolKeysJson = allPoolKeysJson
        await writeFile('pools.json', JSON.stringify(allPoolKeysJson))
      }
    }
  
    findPoolInfoForTokens(mintA, mintB) {
      const poolData = this.allPoolKeysJson.find(
        (i) => (i.baseMint === mintA && i.quoteMint === mintB) || (i.baseMint === mintB && i.quoteMint === mintA)
      )
  
      if (!poolData) return null
  
      return jsonInfo2PoolKeys(poolData)
    }
  
    async _getProgramAccounts(baseMint, quoteMint) {
      const layout = LIQUIDITY_STATE_LAYOUT_V4
  
      return this.connection.getProgramAccounts(new PublicKey(RaydiumSwap.RAYDIUM_V4_PROGRAM_ID), {
        filters: [
          { dataSize: layout.span },
          {
            memcmp: {
              offset: layout.offsetOf('baseMint'),
              bytes: new PublicKey(baseMint).toBase58(),
            },
          },
          {
            memcmp: {
              offset: layout.offsetOf('quoteMint'),
              bytes: new PublicKey(quoteMint).toBase58(),
            },
          },
        ],
      })
    }
  
    async getProgramAccounts(baseMint, quoteMint) {
      const response = await Promise.all([
        this._getProgramAccounts(baseMint, quoteMint),
        this._getProgramAccounts(quoteMint, baseMint),
      ])
  
      return response.filter((r) => r.length > 0)[0] || []
    }
  
    async findRaydiumPoolInfo(baseMint, quoteMint) {
      const layout = LIQUIDITY_STATE_LAYOUT_V4
  
      const programData = await this.getProgramAccounts(baseMint, quoteMint)
  
      const collectedPoolResults = programData
        .map((info) => ({
          id: new PublicKey(info.pubkey),
          version: 4,
          programId: new PublicKey(RaydiumSwap.RAYDIUM_V4_PROGRAM_ID),
          ...layout.decode(info.account.data),
        }))
        .flat()
  
      const pool = collectedPoolResults[0]
  
      if (!pool) return null
  
      const market = await this.connection.getAccountInfo(pool.marketId).then((item) => ({
        programId: item.owner,
        ...MARKET_STATE_LAYOUT_V3.decode(item.data),
      }))
  
      const authority = Liquidity.getAssociatedAuthority({
        programId: new PublicKey(RaydiumSwap.RAYDIUM_V4_PROGRAM_ID),
      }).publicKey
  
      const marketProgramId = market.programId
  
      const poolKeys = {
        id: pool.id,
        baseMint: pool.baseMint,
        quoteMint: pool.quoteMint,
        lpMint: pool.lpMint,
        baseDecimals: Number.parseInt(pool.baseDecimal.toString()),
        quoteDecimals: Number.parseInt(pool.quoteDecimal.toString()),
        lpDecimals: Number.parseInt(pool.baseDecimal.toString()),
        version: pool.version,
        programId: pool.programId,
        openOrders: pool.openOrders,
        targetOrders: pool.targetOrders,
        baseVault: pool.baseVault,
        quoteVault: pool.quoteVault,
        marketVersion: 3,
        authority: authority,
        marketProgramId,
        marketId: market.ownAddress,
        marketAuthority: Market.getAssociatedAuthority({
          programId: marketProgramId,
          marketId: market.ownAddress,
        }).publicKey,
        marketBaseVault: market.baseVault,
        marketQuoteVault: market.quoteVault,
        marketBids: market.bids,
        marketAsks: market.asks,
        marketEventQueue: market.eventQueue,
        withdrawQueue: pool.withdrawQueue,
        lpVault: pool.lpVault,
        lookupTableAccount: PublicKey.default,
      }
  
      return poolKeys
    }
  
    async getOwnerTokenAccounts() {
      const walletTokenAccount = await this.connection.getTokenAccountsByOwner(this.wallet.publicKey, {
        programId: TOKEN_PROGRAM_ID,
      })
  
      return walletTokenAccount.value.map((i) => ({
        pubkey: i.pubkey,
        programId: i.account.owner,
        accountInfo: SPL_ACCOUNT_LAYOUT.decode(i.account.data),
      }))
    }
  
    async getSwapTransaction(
      toToken,
      amount,
      poolKeys,
      maxLamports = 100000,
      useVersionedTransaction = true,
      fixedSide = 'in',
      slippage = 5
    ) {
      const directionIn = poolKeys.quoteMint.toString() == toToken
      const { minAmountOut, amountIn } = await this.calcAmountOut(poolKeys, amount, slippage, directionIn)
  
      const userTokenAccounts = await this.getOwnerTokenAccounts()
      const swapTransaction = await Liquidity.makeSwapInstructionSimple({
        connection: this.connection,
        makeTxVersion: useVersionedTransaction ? 0 : 1,
        poolKeys: {
          ...poolKeys,
        },
        userKeys: {
          tokenAccounts: userTokenAccounts,
          owner: this.wallet.publicKey,
        },
        amountIn: amountIn,
        amountOut: minAmountOut,
        fixedSide: fixedSide,
        config: {
          bypassAssociatedCheck: false,
        },
        computeBudgetConfig: {
          microLamports: maxLamports,
        },
      })
  
      const recentBlockhashForSwap = await this.connection.getLatestBlockhash()
      const instructions = swapTransaction.innerTransactions[0].instructions.filter(Boolean)
  
      if (useVersionedTransaction) {
        const versionedTransaction = new VersionedTransaction(
          new TransactionMessage({
            payerKey: this.wallet.publicKey,
            recentBlockhash: recentBlockhashForSwap.blockhash,
            instructions: instructions,
          }).compileToV0Message()
        )
  
        versionedTransaction.sign([this.wallet.payer])
  
        return versionedTransaction
      }
  
      const legacyTransaction = new Transaction({
        blockhash: recentBlockhashForSwap.blockhash,
        lastValidBlockHeight: recentBlockhashForSwap.lastValidBlockHeight,
        feePayer: this.wallet.publicKey,
      })
  
      legacyTransaction.add(...instructions)
  
      return legacyTransaction
    }
  
    async sendLegacyTransaction(tx) {
      const txid = await this.connection.sendTransaction(tx, [this.wallet.payer], {
        skipPreflight: true,
      })
  
      return txid
    }
  
    async sendVersionedTransaction(tx) {
      const txid = await this.connection.sendTransaction(tx, {
        skipPreflight: true,
      })
  
      return txid
    }
  
    async simulateLegacyTransaction(tx) {
      const txid = await this.connection.simulateTransaction(tx, [this.wallet.payer])
  
      return txid
    }
  
    async simulateVersionedTransaction(tx) {
      const txid = await this.connection.simulateTransaction(tx)
  
      return txid
    }
  
    getTokenAccountByOwnerAndMint(mint) {
      return {
        programId: TOKEN_PROGRAM_ID,
        pubkey: PublicKey.default,
        accountInfo: {
          mint: mint,
          amount: 0,
        },
      }
    }
  
    async calcAmountOut(poolKeys, rawAmountIn, slippage = 5, swapInDirection) {
      const poolInfo = await Liquidity.fetchInfo({ connection: this.connection, poolKeys })
  
      let currencyInMint = poolKeys.baseMint
      let currencyInDecimals = poolInfo.baseDecimals
      let currencyOutMint = poolKeys.quoteMint
      let currencyOutDecimals = poolInfo.quoteDecimals
  
      if (!swapInDirection) {
        currencyInMint = poolKeys.quoteMint
        currencyInDecimals = poolInfo.quoteDecimals
        currencyOutMint = poolKeys.baseMint
        currencyOutDecimals = poolInfo.baseDecimals
      }
  
      const currencyIn = new Token(TOKEN_PROGRAM_ID, currencyInMint, currencyInDecimals)
      const amountIn = new TokenAmount(currencyIn, rawAmountIn.toFixed(currencyInDecimals), false)
      const currencyOut = new Token(TOKEN_PROGRAM_ID, currencyOutMint, currencyOutDecimals)
      const slippageX = new Percent(slippage, 100) // 5% slippage
  
      const { amountOut, minAmountOut, currentPrice, executionPrice, priceImpact, fee } = Liquidity.computeAmountOut({
        poolKeys,
        poolInfo,
        amountIn,
        currencyOut,
        slippage: slippageX,
      })
  
      return {
        amountIn,
        amountOut,
        minAmountOut,
        currentPrice,
        executionPrice,
        priceImpact,
        fee,
      }
    }
  }
  
  export default RaydiumSwap