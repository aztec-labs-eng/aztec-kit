import { describe, it, expect, beforeAll } from "vitest";
import type { AztecAddress } from "@aztec/aztec.js/addresses";
import { Fr } from "@aztec/aztec.js/fields";
import { randomBytes } from "@aztec/foundation/crypto/random";
import { TokenContract } from "@aztec/noir-contracts.js/Token";
import { ProofOfPasswordContract } from "../noir/artifacts/ProofOfPassword.js";

import { setupTestContext, type FPCTestContext } from "./utils.js";

const SALT = Fr.random();
const SIGNING_PRIVATE_KEY = randomBytes(32);
const PASSWORD = "grego rulz";

let ctx: FPCTestContext;

beforeAll(async () => {
  ctx = await setupTestContext();
  // Base fee rises during heavy test setup; give enough headroom so the
  // proven tx's maxFeesPerGas still covers the block's gasFees.
  ctx.wallet.setMinFeePadding(10);
});

describe("ProofOfPassword", () => {
  let token: TokenContract;
  let pop: ProofOfPasswordContract;
  let recipientAddress: AztecAddress;

  beforeAll(async () => {
    const { contract: rawToken } = await TokenContract.deploy(
      ctx.wallet,
      ctx.admin,
      "GregoCoin",
      "GC",
      18,
    ).send({
      from: ctx.admin,
    });
    token = rawToken;

    const { contract: rawPop } = await ProofOfPasswordContract.deploy(
      ctx.wallet,
      token.address,
      PASSWORD,
    ).send({
      from: ctx.admin,
    });
    pop = rawPop;

    await token.methods.set_minter(pop.address, true).send({ from: ctx.admin });

    const recipientSecret = Fr.random();
    const recipientAccountManager = await ctx.wallet.createECDSARAccount(
      recipientSecret,
      SALT,
      SIGNING_PRIVATE_KEY,
    );
    recipientAddress = recipientAccountManager.address;
    await recipientAccountManager.getDeployMethod().then((m) => m.send({ from: ctx.admin }));
  });

  it("mints tokens to recipient on correct password", async () => {
    await pop.methods.check_password_and_mint(PASSWORD, recipientAddress).send({
      from: ctx.admin,
      sendMessagesAs: recipientAddress,
    });

    const { result: balance } = await token.methods
      .balance_of_private(recipientAddress)
      .simulate({ from: recipientAddress });

    expect(balance).toBe(1000n);
  });
});
