import {Trie } from '@ethereumjs/trie';
import { Account, Address } from '@ethereumjs/util';
import {getClient} from "@lodestar/api";
import {createChainForkConfig} from "@lodestar/config";
import {networksChainConfig} from "@lodestar/config/networks";
import {Lightclient} from "@lodestar/light-client";
import {LightClientRestTransport} from "@lodestar/light-client/transport";
import {getFinalizedSyncCheckpoint, getGenesisData, getLcLoggerConsole} from "@lodestar/light-client/utils";
import { keccak256 } from 'ethereum-cryptography/keccak';
import { equalsBytes, hexToBytes } from 'ethereum-cryptography/utils';
import { Button, Frog } from 'frog'
import { devtools } from 'frog/dev'
import { serveStatic } from 'frog/serve-static'
import { handle } from 'frog/vercel'

const config = createChainForkConfig(networksChainConfig.mainnet);
const logger = getLcLoggerConsole({logDebug: Boolean(process.env.DEBUG)});
const api = getClient({urls: ["https://lodestar-mainnet.chainsafe.io"]}, {config});

const lightclient = await Lightclient.initializeFromCheckpointRoot({
    config,
    logger,
    transport: new LightClientRestTransport(api),
    genesisData: await getGenesisData(api),
    checkpointRoot: await getFinalizedSyncCheckpoint(api),
    opts: {
        allowForcedUpdates: true,
        updateHeadersOnForcedUpdate: true,
    }
});

await lightclient.start();


export const app = new Frog({});

export interface Proof {
  readonly address: string;
  readonly balance: string;
  readonly codeHash: string;
  readonly nonce: string;
  readonly storageHash: string;
  readonly accountProof: string[];
  readonly storageProof: {
    readonly key: string;
    readonly value: string;
    readonly proof: string[];
  }[];
}

const emptyAccountRLP = new Account().serialize();

async function isValidAccount({
  address,
  stateRoot,
  proof,
}: {
  address: string;
  stateRoot: Uint8Array;
  proof: Proof;
}): Promise<boolean> {
  const trie = await Trie.create();
  const key = keccak256(Address.fromString(address).toBytes());
  try {
    const expectedAccountRLP = await trie.verifyProof(
      stateRoot,
      key,
      proof.accountProof.map(hexToBytes)
    );

    const account = Account.fromAccountData({
      nonce: BigInt(proof.nonce),
      balance: BigInt(proof.balance),
      storageRoot: proof.storageHash,
      codeHash: proof.codeHash,
    });
    return equalsBytes(account.serialize(), expectedAccountRLP ?? emptyAccountRLP);
  } catch (err) {
    return false;
  }
}

let requestId = 0;

async function getProof(address: string, blockHash: string): Promise<Proof> {
  const body = JSON.stringify({jsonrpc: "2.0", method: "eth_getProof", params: [address, [], blockHash], id: ++requestId});
  return fetch('https://lodestar-mainnetrpc.chainsafe.io',{
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body,
  }).then((res) => res.json()).then(res => res.result);
}

async function fetchLatestPayload() {
  return fetch('https://lodestar-mainnet.chainsafe.io/eth/v2/beacon/blocks/finalized').then((res) => res.json());
}

async function getVerifiedBalance(address: string): Promise<bigint> {
  const payload = await fetchLatestPayload();
  
  const executionPayload = payload.data.message.body["execution_payload"];
  const proof = await getProof(address, executionPayload['block_hash']);
  const validAccount = await isValidAccount({
    address,
    stateRoot: hexToBytes(executionPayload['state_root']),
    proof,
  });
  return BigInt(proof.balance);
}

async function getConnectedAddressForUser(fid: number): Promise<string> {
  const res = await fetch(`https://hub.pinata.cloud/v1/verificationsByFid?fid=${fid}`)
  const json = await res.json();
  return json.messages[0].data.verificationAddAddressBody.address;
}

const WEI_PER_ETH = 10n**18n;

async function getFormattedBalanceFor(fid: number): Promise<string | undefined> {
  const address = await getConnectedAddressForUser(fid);
  const balance: bigint = await getVerifiedBalance(address);
  return `${(balance / WEI_PER_ETH).toLocaleString()} ETH`;
}

function getIntents(response: boolean) {
  return !response ? [<Button value="balance">Get a proof</Button>] : [<Button.Reset>Reset</Button.Reset>]

}

app.use('/*', serveStatic({ root: './public' }));

app.frame('/api', async (c) => {
  const isResponse = c.status === 'response';
  const fid = c.frameData?.fid;
  return c.res({
    image: (
      <div
        style={{
          alignItems: 'center',
          background:
            isResponse
              ? 'linear-gradient(to right, #432889, #17101F)'
              : 'black',
          backgroundSize: '100% 100%',
          display: 'flex',
          flexDirection: 'column',
          flexWrap: 'nowrap',
          height: '100%',
          justifyContent: 'center',
          textAlign: 'center',
          width: '100%',
        }}
      >
        <div
          style={{
            color: 'white',
            fontSize: 60,
            fontStyle: 'normal',
            letterSpacing: '-0.025em',
            lineHeight: 1.4,
            marginTop: 30,
            padding: '0 120px',
            whiteSpace: 'pre-wrap',
          }}
        >
          {isResponse
            ? fid
              ? `Your balance: ${await getFormattedBalanceFor(fid)}`
              : 'No fid'
            : 'Proof of balance'}
        </div>
      </div>
    ),
    intents: getIntents(isResponse),
  })
})

const isProduction = import.meta.env?.MODE !== 'development'
devtools(app, isProduction ? { assetsPath: '/.frog' } : { serveStatic })

export const GET = handle(app)
export const POST = handle(app)
