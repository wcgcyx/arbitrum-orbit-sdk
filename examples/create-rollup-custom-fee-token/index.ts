import { createPublicClient, http, Address, hexToBigInt } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { setValidKeysetPrepareTransactionRequest } from '@arbitrum/orbit-sdk';
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
const PARENT_CHAIN_RPC = process.env.PARENT_CHAIN_RPC;

// IMX on Sepolia.
const CUSTOM_FEE_TOKEN_ADDRESS = "0xe2629e08f4125d14e446660028bD98ee60EE69F2";

// This is the main test account that holds 10,000 IMX, address is 0xd1B7c2EB5f498877edeE27339903BD12f01Fa35b.
// Note: Run `cast send --rpc-url $PARENT_CHAIN_RPC --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 0xd1B7c2EB5f498877edeE27339903BD12f01Fa35b --value 100ether`
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;

// Batcher, anvil default account: 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266.
const BATCH_POSTER_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

// Validator, anvil default account: 0x70997970c51812dc3a010c7d01b50e0d17dc79c8.
const VALIDATOR_PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

// Default keyset for DAS.
const KEYSET = '0x00000000000000010000000000000001012160000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';

function stringToPrivateKey(privateKey: string | undefined): `0x${string}` {
  if (typeof privateKey === 'undefined' || privateKey === '') {
    throw("invalid private key")
  }
  return sanitizePrivateKey(privateKey);
}

async function main() {
  let genBlk = 0;
  const genNumStr = process.env.GENESIS_BLOCK;
  if (genNumStr !== undefined) {
    genBlk = parseInt(genNumStr, 10);
  }
  console.log("Will be deploying in 3s with genesis block number to be ", genBlk);
  await delay(3000);

  // set the parent chain and create a public client for it
  const parentChain = sepolia;
  const parentChainPublicClient = createPublicClient({
    chain: parentChain,
    transport: http(PARENT_CHAIN_RPC),
  });
  // load the deployer account
  const deployer = privateKeyToAccount(stringToPrivateKey(process.env.DEPLOYER_PRIVATE_KEY));
  // load or generate a random batch poster account
  const batchPoster = privateKeyToAccount(BATCH_POSTER_PRIVATE_KEY);
  // load or generate a random validator account
  const validator = privateKeyToAccount(VALIDATOR_PRIVATE_KEY);
  // set the custom fee token to be IMX on Sepolia
  const nativeToken: Address = CUSTOM_FEE_TOKEN_ADDRESS;

  // Make sure deployer has enough ETH.
  const bal = await parentChainPublicClient.getBalance({
    address: deployer.address,
  });
  if (bal === hexToBigInt("0x0")) {
    console.log("deployer not funded, run `cast send --rpc-url $PARENT_CHAIN_RPC --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 0xd1B7c2EB5f498877edeE27339903BD12f01Fa35b --value 100ether`");
    exec(`cast send --rpc-url ${PARENT_CHAIN_RPC} --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 0xd1B7c2EB5f498877edeE27339903BD12f01Fa35b --value 100ether`, (err, stdout, stderr) => {
      if (err) {
        exit(1)
        return;
      }
      console.log(`stdout: ${stdout}`);
      console.log(`stderr: ${stderr}`);
    });
  }

  // Deploy rollup
  let chainConfig = prepareChainConfig({
    chainId: 15003,
    arbitrum: {
      InitialChainOwner: deployer.address,
      DataAvailabilityCommittee: true,
    },
  });
  chainConfig.arbitrum.GenesisBlockNum = genBlk;
  const createRollupConfig = createRollupPrepareDeploymentParamsConfig(parentChainPublicClient, {
    chainId: BigInt(15003), // Use chain ID of 15003
    owner: deployer.address,
    genesisBlockNum: BigInt(genBlk),
    chainConfig: chainConfig,
  });
  let res = await createRollup({
    params: {
      config: createRollupConfig,
      batchPosters: [batchPoster.address],
      validators: [validator.address],
      nativeToken,
    },
    account: deployer,
    parentChainPublicClient,
  });

  // Configure keyset
  const txRequest = await setValidKeysetPrepareTransactionRequest({
    coreContracts: {
      upgradeExecutor: res.coreContracts.upgradeExecutor,
      sequencerInbox: res.coreContracts.sequencerInbox,
    },
    keyset: KEYSET,
    account: deployer.address,
    publicClient: parentChainPublicClient,
  });

  // sign and send the transaction
  const txHash = await parentChainPublicClient.sendRawTransaction({
    serializedTransaction: await deployer.signTransaction(txRequest),
  });
  // wait for the transaction receipt
  const txReceipt = await parentChainPublicClient.waitForTransactionReceipt({ hash: txHash });
  console.log("Keyset updated in tx ", txReceipt.transactionHash);
  console.log("Rollup deployed and configured: ");
  console.log(res.coreContracts);

  console.log("Start DAS with: (in nitro dir)");
  console.log("===========================");
  console.log(`export SEQUENCER_INBOX_ADDRESS=${res.coreContracts.sequencerInbox}`);
  console.log("rm -rf ./testdir/data");
  console.log("mkdir ./testdir/data");
  console.log(`./target/bin/daserver --data-availability.parent-chain-node-url ${PARENT_CHAIN_RPC} --enable-rpc --rpc-addr '0.0.0.0' --enable-rest --rest-addr '0.0.0.0' --log-level 3 --data-availability.local-file-storage.enable --data-availability.local-file-storage.data-dir ./testdir/data --data-availability.key.key-dir ./testdir/keys --data-availability.local-cache.enable --data-availability.sequencer-inbox-address $SEQUENCER_INBOX_ADDRESS`)
  console.log("===========================");

  console.log("Start nitro with ./nodeConfig.json: ");
  const infoJson = `[{\"chain-id\":15003,\"parent-chain-id\":11155111,\"parent-chain-is-arbitrum\":false,\"chain-name\":\"IMX\",\"chain-config\":` + 
  `{\"homesteadBlock\":0,\"daoForkBlock\":null,\"daoForkSupport\":true,\"eip150Block\":0,\"eip150Hash\":\"0x0000000000000000000000000000000000000000000000000000000000000000\",\"eip155Block\":0,\"eip158Block\":0,\"byzantiumBlock\":0,\"constantinopleBlock\":0,\"petersburgBlock\":0,\"istanbulBlock\":0,\"muirGlacierBlock\":0,\"berlinBlock\":0,\"londonBlock\":0,\"clique\":{\"period\":0,\"epoch\":0},` +
  `\"arbitrum\":{\"EnableArbOS\":true,\"AllowDebugPrecompiles\":false,\"DataAvailabilityCommittee\":true,\"InitialArbOSVersion\":32,\"GenesisBlockNum\":${genBlk},\"MaxCodeSize\":24576,\"MaxInitCodeSize\":49152,\"InitialChainOwner\":\"${deployer.address}\"},\"chainId\":15003},\"rollup\":{\"bridge\":\"${res.coreContracts.bridge}\",\"inbox\":\"${res.coreContracts.inbox}\",\"sequencer-inbox\":\"${res.coreContracts.sequencerInbox}\",\"rollup\":\"${res.coreContracts.rollup}\",\"validator-utils\":\"${res.coreContracts.validatorUtils}\",\"validator-wallet-creator\":\"${res.coreContracts.validatorWalletCreator}\",\"deployed-at\":${res.coreContracts.deployedAtBlockNumber}}}]`;
  let nodeConfig = JSON.parse(fs.readFileSync('nodeConfig.example.json', 'utf-8'));
  nodeConfig.chain['info-json'] = infoJson;
  nodeConfig.node['data-availability']['sequencer-inbox-address'] = res.coreContracts.sequencerInbox;
  fs.writeFileSync('nodeConfig.json', JSON.stringify(nodeConfig));
  console.log("===========================");
  console.log("rm -rf ~/.arbitrum");
  console.log("mkdir -p ~/.arbitrum/IMX/nitro/l2chaindata");
  console.log("cp -r ../go-ethereum/imxdir/devnet/chain-15003/validator-0/geth/chaindata/* ~/.arbitrum/IMX/nitro/l2chaindata");
  console.log(`GEN_BLK=${genBlk} ./target/bin/nitro --conf.file ../arbitrum-orbit-sdk/examples/create-rollup-custom-fee-token/nodeConfig.json`);
  console.log("===========================");

  console.log("Configure chain with ./orbitSetupScriptConfig.json");
  let scriptConfig = {
    "networkFeeReceiver": deployer.address,
    "infrastructureFeeCollector": deployer.address,
    "staker": validator.address,
    "batchPoster": batchPoster.address,
    "chainOwner": deployer.address,
    "chainId": 15003,
    "chainName": "IMX",
    "minL2BaseFee": 100000000,
    "parentChainId": 11155111,
    "parent-chain-node-url": PARENT_CHAIN_RPC,
    "rollup": res.coreContracts.rollup,
    "inbox": res.coreContracts.inbox,
    "nativeToken": res.coreContracts.nativeToken,
    "outbox": res.coreContracts.outbox,
    "rollupEventInbox": res.coreContracts.rollupEventInbox,
    "challengeManager": res.coreContracts.challengeManager,
    "adminProxy": res.coreContracts.adminProxy,
    "sequencerInbox": res.coreContracts.sequencerInbox,
    "bridge": res.coreContracts.bridge,
    "upgradeExecutor": res.coreContracts.upgradeExecutor,
    "validatorUtils": res.coreContracts.validatorUtils,
    "validatorWalletCreator": res.coreContracts.validatorWalletCreator,
    "deployedAtBlockNumber": res.coreContracts.deployedAtBlockNumber
  }
  fs.writeFileSync('orbitSetupScriptConfig.json', JSON.stringify(scriptConfig));
  console.log("===========================");
  console.log("rm -rf ./config/orbitSetupScriptConfig.json ./config/resumeState.json");
  console.log("cp ../arbitrum-orbit-sdk/examples/create-rollup-custom-fee-token/orbitSetupScriptConfig.json ./config/");
  console.log(`PRIVATE_KEY=${DEPLOYER_PRIVATE_KEY} L2_RPC_URL="${PARENT_CHAIN_RPC}" L3_RPC_URL="http://localhost:8449" yarn run setup`);
  console.log("===========================");

  console.log("After script failed, continue from here with command below.")
  console.log("===========================");
  console.log("yarn setup")
  console.log("===========================");
}

function delay(ms: number) {
  return new Promise( resolve => setTimeout(resolve, ms) );
}

main();