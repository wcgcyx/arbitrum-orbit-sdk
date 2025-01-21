import { createPublicClient, http, Address, hexToBigInt, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { createTokenBridgePrepareTransactionReceipt, createTokenBridgePrepareTransactionRequest, setValidKeysetPrepareTransactionRequest } from '@arbitrum/orbit-sdk';
import {
  prepareChainConfig,
  createRollupPrepareDeploymentParamsConfig,
  createRollup,
} from '@arbitrum/orbit-sdk';
import { config } from 'dotenv';
import { exec } from 'child_process';
import fs from 'fs'
import { exit } from 'process';
import { sanitizePrivateKey } from '@arbitrum/orbit-sdk/utils';
config();

// Local sepolia fork.
const PARENT_CHAIN_RPC = "http://localhost:8544/";

// This is the main test account that holds 10,000 IMX, address is 0xd1B7c2EB5f498877edeE27339903BD12f01Fa35b.
// Note: Run `cast send --rpc-url http://localhost:8544 --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 0xd1B7c2EB5f498877edeE27339903BD12f01Fa35b --value 100ether`
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;

function stringToPrivateKey(privateKey: string | undefined): `0x${string}` {
  if (typeof privateKey === 'undefined' || privateKey === '') {
    throw("invalid private key")
  }
  return sanitizePrivateKey(privateKey);
}

async function main() {
  let nodeConfig = JSON.parse(fs.readFileSync('orbitSetupScriptConfig.json', 'utf-8'));

  // set the parent chain and create a public client for it
  const parentChain = sepolia;
  const parentChainPublicClient = createPublicClient({
    chain: parentChain,
    transport: http(PARENT_CHAIN_RPC),
  });

  // define chain config for the orbit chain
  const orbitChain = defineChain({
    id: 15003,
    network: 'IMX',
    name: 'imx',
    nativeCurrency: { name: 'Immutable', symbol: 'IMX', decimals: 18 },
    rpcUrls: {
      default: {
        http: ["http://localhost:8449"],
      },
      public: {
        http: ["http://localhost:8449"],
      },
    },
    testnet: true,
  });
  const orbitChainPublicClient = createPublicClient({ chain: orbitChain, transport: http() });

  // load the deployer account
  const deployer = privateKeyToAccount(stringToPrivateKey(process.env.DEPLOYER_PRIVATE_KEY));

    // prepare the transaction for deploying the core contracts
    const txRequest = await createTokenBridgePrepareTransactionRequest({
      params: {
        rollup: nodeConfig.rollup,
        rollupOwner: deployer.address,
      },
      parentChainPublicClient,
      orbitChainPublicClient,
      account: deployer.address,
    });
  
    // sign and send the transaction
    console.log(`Deploying the TokenBridge...`);
    const txHash = await parentChainPublicClient.sendRawTransaction({
      serializedTransaction: await deployer.signTransaction(txRequest),
    });
  
    // get the transaction receipt after waiting for the transaction to complete
    const txReceipt = createTokenBridgePrepareTransactionReceipt(
      await parentChainPublicClient.waitForTransactionReceipt({ hash: txHash }),
    );
    console.log(`Deployed in /tx/${txReceipt.transactionHash}`);
  
    // wait for retryables to execute
    console.log(`Waiting for retryable tickets to execute on the Orbit chain...`);
    const orbitChainRetryableReceipts = await txReceipt.waitForRetryables({
      orbitPublicClient: orbitChainPublicClient,
    });
    console.log(`Retryables executed`);
    console.log(
      `Transaction hash for first retryable is ${orbitChainRetryableReceipts[0].transactionHash}`,
    );
    console.log(
      `Transaction hash for second retryable is ${orbitChainRetryableReceipts[1].transactionHash}`,
    );
  
    // fetching the TokenBridge contracts
    const tokenBridgeContracts = await txReceipt.getTokenBridgeContracts({
      parentChainPublicClient,
    });
    console.log(`TokenBridge contracts:`, tokenBridgeContracts);
}

main();