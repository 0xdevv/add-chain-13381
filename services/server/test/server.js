process.env.NODE_CONFIG_ENV = "test";
process.env.IPFS_GATEWAY = "http://ipfs-mock/ipfs/";
process.env.FETCH_TIMEOUT = 8000; // instantiated http-gateway takes a little longer

process.env.SOURCIFY_POSTGRES_HOST = "localhost";
process.env.SOURCIFY_POSTGRES_DB = "sourcify";
process.env.SOURCIFY_POSTGRES_USER = "sourcify";
process.env.SOURCIFY_POSTGRES_PASSWORD = "sourcify";
process.env.SOURCIFY_POSTGRES_PORT =
  process.env.DOCKER_HOST_POSTGRES_TEST_PORT || 5431;
process.env.ALLIANCE_POSTGRES_HOST = "";

const Server = require("../dist/server/server").Server;
const {
  assertValidationError,
  assertVerification,
  assertVerificationSession,
  assertLookup,
  invalidAddress,
  assertLookupAll,
} = require("./helpers/assertions");
const ganache = require("ganache");
const chai = require("chai");
const chaiHttp = require("chai-http");
const util = require("util");
const fs = require("fs");
const rimraf = require("rimraf");
const path = require("path");
const config = require("config");
const { StorageService } = require("../dist/server/services/StorageService");
const {
  createCheckedContract,
} = require("../dist/server/controllers/verification/verification.common");
const _checkedContract = require("./testcontracts/Database/CheckedContract.json");
const match = require("./testcontracts/Database/Match.json");

const MAX_FILE_SIZE = config.get("server.maxFileSize");
const MAX_SESSION_SIZE =
  require("../dist/server/controllers/verification/verification.common").MAX_SESSION_SIZE;
const GANACHE_PORT = 8545;
const StatusCodes = require("http-status-codes").StatusCodes;
const {
  waitSecs,
  callContractMethodWithTx,
  deployFromAbiAndBytecodeForCreatorTxHash,
  readFilesFromDirectory,
} = require("./helpers/helpers");
const { deployFromAbiAndBytecode } = require("./helpers/helpers");
const { verifierAllianceTest } = require("./helpers/verifierAlliance");
const { JsonRpcProvider, Network, id: keccak256str } = require("ethers");
const { LOCAL_CHAINS } = require("../dist/sourcify-chains");
const nock = require("nock");

chai.use(chaiHttp);

const EXTENDED_TIME = 20000; // 20 seconds
const EXTENDED_TIME_60 = 60000; // 60 seconds

const defaultContractChain = "1337"; // default 1337

describe("Server", function () {
  const server = new Server();
  const ganacheServer = ganache.server({
    wallet: { totalAccounts: 1 },
    chain: {
      chainId: parseInt(defaultContractChain),
      networkId: parseInt(defaultContractChain),
    },
  });
  let localSigner;
  let defaultContractAddress;
  let currentResponse = null; // to log server response when test fails

  const sourcePath = path.join(
    __dirname,
    "testcontracts",
    "Storage",
    "Storage.sol"
  );
  const sourceBuffer = fs.readFileSync(sourcePath);

  const artifact = require(path.join(
    __dirname,
    "testcontracts",
    "Storage",
    "Storage.json"
  ));
  const metadata = require(path.join(
    __dirname,
    "testcontracts",
    "Storage",
    "metadata.json"
  ));
  const metadataBuffer = Buffer.from(JSON.stringify(metadata));

  this.timeout(EXTENDED_TIME);
  before(async () => {
    await ganacheServer.listen(GANACHE_PORT);

    // Init IPFS mock with all the necessary pinned files
    const mockContent = await readFilesFromDirectory(
      path.join(__dirname, "mocks", "ipfs")
    );
    for (let ipfsKey of Object.keys(mockContent)) {
      nock(process.env.IPFS_GATEWAY)
        .persist()
        .get("/" + ipfsKey)
        .reply(function (uri, requestBody) {
          return [200, mockContent[ipfsKey]];
        });
    }

    const sourcifyChainGanache = LOCAL_CHAINS[0];
    console.log("Started ganache local server on port " + GANACHE_PORT);
    const ethersNetwork = new Network(
      sourcifyChainGanache.rpc[0],
      sourcifyChainGanache.chainId
    );
    localSigner = await new JsonRpcProvider(
      `http://localhost:${GANACHE_PORT}`,
      ethersNetwork,
      { staticNetwork: ethersNetwork }
    ).getSigner();
    console.log("Initialized Provider");

    // Deploy the test contract
    defaultContractAddress = await deployFromAbiAndBytecode(
      localSigner,
      artifact.abi,
      artifact.bytecode
    );

    const promisified = util.promisify(server.app.listen);
    await promisified(server.port);
    console.log(`Server listening on port ${server.port}!`);
  });

  beforeEach(() => {
    rimraf.sync(server.repository);
  });

  after(async () => {
    rimraf.sync(server.repository);
    await ganacheServer.close();
  });

  // log server response when test fails
  afterEach(function () {
    const errorBody = currentResponse && currentResponse.body;
    if (this.currentTest.state === "failed" && errorBody) {
      console.log(
        "Server response of failed test " + this.currentTest.title + ":"
      );
      console.log(errorBody);
    }
    currentResponse = null;
  });

  const ipfsAddress =
    metadata.sources["project:/contracts/Storage.sol"].urls[1];

  // change the last char in ipfs hash of the source file
  const lastChar = ipfsAddress.charAt(ipfsAddress.length - 1);
  const modifiedLastChar = lastChar === "a" ? "b" : "a";
  const modifiedIpfsAddress =
    ipfsAddress.slice(0, ipfsAddress.length - 1) + modifiedLastChar;
  const modifiedIpfsMetadata = { ...metadata };
  modifiedIpfsMetadata.sources["project:/contracts/Storage.sol"].urls[1] =
    modifiedIpfsAddress;
  const modifiedIpfsMetadataBuffer = Buffer.from(JSON.stringify(metadata));

  const assertBytecodesDontMatch = (err, res, done) => {
    chai.expect(err).to.be.null;
    chai.expect(res.status).to.equal(StatusCodes.INTERNAL_SERVER_ERROR);
    chai.expect(res.body).to.haveOwnProperty("error");
    chai
      .expect(res.body.error)
      .to.include("The deployed and recompiled bytecode don't match.");
    if (done) done();
  };

  function assertEqualityFromPath(obj1, obj2path, options) {
    const obj2raw = fs.readFileSync(obj2path).toString();
    const obj2 = options?.isJson ? JSON.parse(obj2raw) : obj2raw;
    chai.expect(obj1, `assertFromPath: ${obj2path}`).to.deep.equal(obj2);
  }

  describe("/check-by-addresses", function () {
    this.timeout(EXTENDED_TIME);

    it("should fail for missing chainIds", (done) => {
      chai
        .request(server.app)
        .get("/check-by-addresses")
        .query({ addresses: defaultContractAddress })
        .end((err, res) => {
          assertValidationError(err, res, "chainIds");
          done();
        });
    });

    it("should fail for missing addresses", (done) => {
      chai
        .request(server.app)
        .get("/check-by-addresses")
        .query({ chainIds: 1 })
        .end((err, res) => {
          assertValidationError(err, res, "addresses");
          done();
        });
    });

    it("should return false for previously unverified contract", (done) => {
      chai
        .request(server.app)
        .get("/check-by-addresses")
        .query({
          chainIds: defaultContractChain,
          addresses: defaultContractAddress,
        })
        .end((err, res) => {
          assertLookup(err, res, defaultContractAddress, "false");
          done();
        });
    });

    it("should fail for invalid address", (done) => {
      chai
        .request(server.app)
        .get("/check-by-addresses")
        .query({ chainIds: defaultContractChain, addresses: invalidAddress })
        .end((err, res) => {
          assertValidationError(err, res, "addresses");
          done();
        });
    });

    it("should return false for unverified contract but then perfect after verification", (done) => {
      chai
        .request(server.app)
        .get("/check-by-addresses")
        .query({
          chainIds: defaultContractChain,
          addresses: defaultContractAddress,
        })
        .end((err, res) => {
          assertLookup(err, res, defaultContractAddress, "false");
          chai
            .request(server.app)
            .post("/")
            .field("address", defaultContractAddress)
            .field("chain", defaultContractChain)
            .attach("files", metadataBuffer, "metadata.json")
            .attach("files", sourceBuffer)
            .end((err, res) => {
              chai.expect(err).to.be.null;
              chai.expect(res.status).to.equal(StatusCodes.OK);

              chai
                .request(server.app)
                .get("/check-by-addresses")
                .query({
                  chainIds: defaultContractChain,
                  addresses: defaultContractAddress,
                })
                .end((err, res) =>
                  assertLookup(
                    err,
                    res,
                    defaultContractAddress,
                    "perfect",
                    done
                  )
                );
            });
        });
    });

    it("should convert addresses to checksummed format", (done) => {
      chai
        .request(server.app)
        .get("/check-by-addresses")
        .query({
          chainIds: defaultContractChain,
          addresses: defaultContractAddress.toLowerCase(),
        })
        .end((err, res) => {
          assertLookup(err, res, defaultContractAddress, "false", done);
        });
    });
  });

  describe("/check-all-by-addresses", function () {
    this.timeout(EXTENDED_TIME);

    it("should fail for missing chainIds", (done) => {
      chai
        .request(server.app)
        .get("/check-all-by-addresses")
        .query({ addresses: defaultContractAddress })
        .end((err, res) => {
          assertValidationError(err, res, "chainIds");
          done();
        });
    });

    it("should fail for missing addresses", (done) => {
      chai
        .request(server.app)
        .get("/check-all-by-addresses")
        .query({ chainIds: 1 })
        .end((err, res) => {
          assertValidationError(err, res, "addresses");
          done();
        });
    });

    it("should return false for previously unverified contract", (done) => {
      chai
        .request(server.app)
        .get("/check-all-by-addresses")
        .query({
          chainIds: defaultContractChain,
          addresses: defaultContractAddress,
        })
        .end((err, res) =>
          assertLookup(err, res, defaultContractAddress, "false", done)
        );
    });

    it("should fail for invalid address", (done) => {
      chai
        .request(server.app)
        .get("/check-all-by-addresses")
        .query({ chainIds: defaultContractChain, addresses: invalidAddress })
        .end((err, res) => {
          assertValidationError(err, res, "addresses");
          done();
        });
    });

    it("should return false for unverified contract but then perfect after verification", (done) => {
      chai
        .request(server.app)
        .get("/check-all-by-addresses")
        .query({
          chainIds: defaultContractChain,
          addresses: defaultContractAddress,
        })
        .end((err, res) => {
          assertLookup(err, res, defaultContractAddress, "false");
          chai
            .request(server.app)
            .post("/")
            .field("address", defaultContractAddress)
            .field("chain", defaultContractChain)
            .attach("files", metadataBuffer, "metadata.json")
            .attach("files", sourceBuffer)
            .end((err, res) => {
              chai.expect(err).to.be.null;
              chai.expect(res.status).to.equal(StatusCodes.OK);

              chai
                .request(server.app)
                .get("/check-all-by-addresses")
                .query({
                  chainIds: defaultContractChain,
                  addresses: defaultContractAddress,
                })
                .end((err, res) =>
                  assertLookupAll(
                    err,
                    res,
                    defaultContractAddress,
                    [{ chainId: defaultContractChain, status: "perfect" }],
                    done
                  )
                );
            });
        });
    });

    it("should convert addresses to checksummed format", (done) => {
      chai
        .request(server.app)
        .get("/check-all-by-addresses")
        .query({
          chainIds: defaultContractChain,
          addresses: defaultContractAddress.toLowerCase(),
        })
        .end((err, res) => {
          chai.expect(err).to.be.null;
          chai.expect(res.status).to.equal(StatusCodes.OK);
          chai.expect(res.body).to.have.a.lengthOf(1);
          const result = res.body[0];
          chai.expect(result.address).to.equal(defaultContractAddress);
          chai.expect(result.status).to.equal("false");
          done();
        });
    });
  });

  const checkNonVerified = (path, done) => {
    chai
      .request(server.app)
      .post(path)
      .field("chain", defaultContractChain)
      .field("address", defaultContractAddress)
      .end((err, res) => {
        chai.expect(err).to.be.null;
        chai.expect(res.body).to.haveOwnProperty("error");
        chai.expect(res.status).to.equal(StatusCodes.NOT_FOUND);
        done();
      });
  };

  describe("/", function () {
    this.timeout(EXTENDED_TIME);

    it("should correctly inform for an address check of a non verified contract (at /)", (done) => {
      checkNonVerified("/", done);
    });

    it("should correctly inform for an address check of a non verified contract (at /verify)", (done) => {
      checkNonVerified("/verify", done);
    });

    it("should verify multipart upload", (done) => {
      chai
        .request(server.app)
        .post("/")
        .field("address", defaultContractAddress)
        .field("chain", defaultContractChain)
        .attach("files", metadataBuffer, "metadata.json")
        .attach("files", sourceBuffer, "Storage.sol")
        .end((err, res) =>
          assertVerification(
            err,
            res,
            done,
            defaultContractAddress,
            defaultContractChain,
            "perfect"
          )
        );
    });

    it("should verify json upload with string properties", (done) => {
      chai
        .request(server.app)
        .post("/")
        .send({
          address: defaultContractAddress,
          chain: defaultContractChain,
          files: {
            "metadata.json": metadataBuffer.toString(),
            "Storage.sol": sourceBuffer.toString(),
          },
        })
        .end((err, res) =>
          assertVerification(
            err,
            res,
            done,
            defaultContractAddress,
            defaultContractChain,
            "perfect"
          )
        );
    });

    it("should verify json upload with Buffer properties", (done) => {
      chai
        .request(server.app)
        .post("/")
        .send({
          address: defaultContractAddress,
          chain: defaultContractChain,
          files: {
            "metadata.json": metadataBuffer,
            "Storage.sol": sourceBuffer,
          },
        })
        .end((err, res) =>
          assertVerification(
            err,
            res,
            done,
            defaultContractAddress,
            defaultContractChain,
            "perfect"
          )
        );
    });

    const assertMissingFile = (err, res) => {
      chai.expect(err).to.be.null;
      chai.expect(res.body).to.haveOwnProperty("error");
      const errorMessage = res.body.error.toLowerCase();
      chai.expect(res.status).to.equal(StatusCodes.INTERNAL_SERVER_ERROR);
      chai.expect(errorMessage).to.include("missing");
      chai.expect(errorMessage).to.include("Storage".toLowerCase());
    };

    it("should return Bad Request Error for a source that is missing and unfetchable", (done) => {
      chai
        .request(server.app)
        .post("/")
        .field("address", defaultContractAddress)
        .field("chain", defaultContractChain)
        .attach("files", modifiedIpfsMetadataBuffer, "metadata.json")
        .end((err, res) => {
          assertMissingFile(err, res);
          done();
        });
    });

    it("should fetch a missing file that is accessible via ipfs", (done) => {
      chai
        .request(server.app)
        .post("/")
        .field("address", defaultContractAddress)
        .field("chain", defaultContractChain)
        .attach("files", metadataBuffer, "metadata.json")
        .end((err, res) =>
          assertVerification(
            err,
            res,
            done,
            defaultContractAddress,
            defaultContractChain,
            "perfect"
          )
        );
    });

    it("should return 'partial', then delete partial when 'full' match", (done) => {
      const partialMetadata = require(path.join(
        __dirname,
        "./testcontracts/Storage/metadataModified.json"
      ));
      const partialMetadataBuffer = Buffer.from(
        JSON.stringify(partialMetadata)
      );

      const partialSourcePath = path.join(
        __dirname,
        "testcontracts",
        "Storage",
        "StorageModified.sol"
      );
      const partialSourceBuffer = fs.readFileSync(partialSourcePath);

      const partialMetadataURL = `/repository/contracts/partial_match/${defaultContractChain}/${defaultContractAddress}/metadata.json`;

      chai
        .request(server.app)
        .post("/")
        .field("address", defaultContractAddress)
        .field("chain", defaultContractChain)
        .attach("files", partialMetadataBuffer, "metadata.json")
        .attach("files", partialSourceBuffer)
        .end((err, res) => {
          assertVerification(
            err,
            res,
            null,
            defaultContractAddress,
            defaultContractChain,
            "partial"
          );

          chai
            .request(server.app)
            .get(partialMetadataURL)
            .end((err, res) => {
              chai.expect(err).to.be.null;
              chai.expect(res.body).to.deep.equal(partialMetadata);

              chai
                .request(server.app)
                .post("/")
                .field("address", defaultContractAddress)
                .field("chain", defaultContractChain)
                .attach("files", metadataBuffer, "metadata.json")
                .attach("files", sourceBuffer)
                .end(async (err, res) => {
                  assertVerification(
                    err,
                    res,
                    null,
                    defaultContractAddress,
                    defaultContractChain
                  );

                  await waitSecs(2); // allow server some time to execute the deletion (it started *after* the last response)
                  chai
                    .request(server.app)
                    .get(partialMetadataURL)
                    .end((err, res) => {
                      chai.expect(err).to.be.null;
                      chai.expect(res.status).to.equal(StatusCodes.NOT_FOUND);
                      done();
                    });
                });
            });
        });
    });

    it("should mark contracts without an embedded metadata hash as a 'partial' match", async () => {
      // Simple contract without bytecode at https://goerli.etherscan.io/address/0x093203902B71Cdb1dAA83153b3Df284CD1a2f88d
      const bytecode =
        "0x6080604052348015600f57600080fd5b50601680601d6000396000f3fe6080604052600080fdfea164736f6c6343000700000a";
      const metadataPath = path.join(
        __dirname,
        "sources",
        "metadata",
        "withoutMetadataHash.meta.object.json"
      );
      const metadataBuffer = fs.readFileSync(metadataPath);
      const metadata = JSON.parse(metadataBuffer.toString());
      const address = await deployFromAbiAndBytecode(
        localSigner,
        metadata.output.abi,
        bytecode
      );

      const res = await chai
        .request(server.app)
        .post("/")
        .field("address", address)
        .field("chain", defaultContractChain)
        .attach("files", metadataBuffer, "metadata.json");

      assertVerification(
        null,
        res,
        null,
        address,
        defaultContractChain,
        "partial"
      );
    });

    it("should verify a contract with immutables and save immutable-references.json", async () => {
      const artifact = require(path.join(
        __dirname,
        "./testcontracts/WithImmutables/artifact.json"
      ));
      const { contractAddress } =
        await deployFromAbiAndBytecodeForCreatorTxHash(
          localSigner,
          artifact.abi,
          artifact.bytecode,
          [999]
        );

      const metadata = require(path.join(
        __dirname,
        "./testcontracts/WithImmutables/metadata.json"
      ));
      const sourcePath = path.join(
        __dirname,
        "testcontracts",
        "WithImmutables",
        "sources",
        "WithImmutables.sol"
      );
      const sourceBuffer = fs.readFileSync(sourcePath);

      // Now pass the creatorTxHash
      const res = await chai
        .request(server.app)
        .post("/")
        .send({
          address: contractAddress,
          chain: defaultContractChain,
          files: {
            "metadata.json": JSON.stringify(metadata),
            "WithImmutables.sol": sourceBuffer.toString(),
          },
        });
      assertVerification(
        null,
        res,
        null,
        contractAddress,
        defaultContractChain
      );
      const isExist = fs.existsSync(
        path.join(
          server.repository,
          "contracts",
          "full_match",
          defaultContractChain,
          contractAddress,
          "immutable-references.json"
        )
      );
      chai.expect(isExist, "Immutable references not saved").to.be.true;
    });

    it("should return validation error for adding standard input JSON without a compiler version", async () => {
      const address = await deployFromAbiAndBytecode(
        localSigner,
        artifact.abi, // Storage.sol
        artifact.bytecode
      );
      const solcJsonPath = path.join(
        __dirname,
        "testcontracts",
        "Storage",
        "StorageJsonInput.json"
      );
      const solcJsonBuffer = fs.readFileSync(solcJsonPath);

      const res = await chai
        .request(server.app)
        .post("/verify/solc-json")
        .attach("files", solcJsonBuffer, "solc.json")
        .field("address", address)
        .field("chain", defaultContractChain)
        .field("contractName", "Storage");

      assertValidationError(null, res, "compilerVersion");
    });

    it("should return validation error for adding standard input JSON without a contract name", async () => {
      const address = await deployFromAbiAndBytecode(
        localSigner,
        artifact.abi, // Storage.sol
        artifact.bytecode
      );
      const solcJsonPath = path.join(
        __dirname,
        "testcontracts",
        "Storage",
        "StorageJsonInput.json"
      );
      const solcJsonBuffer = fs.readFileSync(solcJsonPath);

      const res = await chai
        .request(server.app)
        .post("/verify/solc-json")
        .attach("files", solcJsonBuffer)
        .field("address", address)
        .field("chain", defaultContractChain)
        .field("compilerVersion", "0.8.4+commit.c7e474f2");

      assertValidationError(null, res, "contractName");
    });

    it("should verify a contract with Solidity standard input JSON", async () => {
      const address = await deployFromAbiAndBytecode(
        localSigner,
        artifact.abi, // Storage.sol
        artifact.bytecode
      );
      const solcJsonPath = path.join(
        __dirname,
        "testcontracts",
        "Storage",
        "StorageJsonInput.json"
      );
      const solcJsonBuffer = fs.readFileSync(solcJsonPath);

      const res = await chai
        .request(server.app)
        .post("/verify/solc-json")
        .attach("files", solcJsonBuffer, "solc.json")
        .field("address", address)
        .field("chain", defaultContractChain)
        .field("compilerVersion", "0.8.4+commit.c7e474f2")
        .field("contractName", "Storage");

      assertVerification(null, res, null, address, defaultContractChain);
    });
    describe("hardhat build-info file support", function () {
      this.timeout(EXTENDED_TIME);
      let address;
      const mainContractIndex = 5;
      const hardhatOutputJSON = require(path.join(
        __dirname,
        "./sources/hardhat-output/output.json"
      ));
      const MyToken =
        hardhatOutputJSON.output.contracts["contracts/MyToken.sol"].MyToken;
      const hardhatOutputBuffer = Buffer.from(
        JSON.stringify(hardhatOutputJSON)
      );
      before(async function () {
        address = await deployFromAbiAndBytecode(
          localSigner,
          MyToken.abi,
          MyToken.evm.bytecode.object,
          ["Sourcify Hardhat Test", "TEST"]
        );
        console.log(`Contract deployed at ${address}`);
        await waitSecs(3);
      });

      it("should detect multiple contracts in the build-info file", (done) => {
        chai
          .request(server.app)
          .post("/")
          .field("chain", defaultContractChain)
          .field("address", address)
          .attach("files", hardhatOutputBuffer)
          .then((res) => {
            chai.expect(res.status).to.equal(StatusCodes.BAD_REQUEST);
            chai.expect(res.body.contractsToChoose.length).to.be.equal(6);
            chai
              .expect(res.body.error)
              .to.be.a("string")
              .and.satisfy((msg) => msg.startsWith("Detected "));
            done();
          });
      });

      it("should verify the chosen contract in the build-info file", (done) => {
        chai
          .request(server.app)
          .post("/")
          .field("chain", defaultContractChain)
          .field("address", address)
          .field("chosenContract", mainContractIndex)
          .attach("files", hardhatOutputBuffer)
          .end((err, res) => {
            assertVerification(
              err,
              res,
              done,
              address,
              defaultContractChain,
              "perfect"
            );
          });
      });

      it("should store a contract in /contracts/full_match|partial_match/0xADDRESS despite the files paths in the metadata", async () => {
        const artifact = require(path.join(
          __dirname,
          "./testcontracts/Storage/Storage.json"
        ));
        const { contractAddress } =
          await deployFromAbiAndBytecodeForCreatorTxHash(
            localSigner,
            artifact.abi,
            artifact.bytecode,
            []
          );

        const metadata = require(path.join(
          __dirname,
          "./testcontracts/Storage/metadata.upMultipleDirs.json"
        ));
        const sourcePath = path.join(
          __dirname,
          "testcontracts",
          "Storage",
          "Storage.sol"
        );
        const sourceBuffer = fs.readFileSync(sourcePath);

        // Now pass the creatorTxHash
        const res = await chai
          .request(server.app)
          .post("/")
          .send({
            address: contractAddress,
            chain: defaultContractChain,
            files: {
              "metadata.json": JSON.stringify(metadata),
              "Storage.sol": sourceBuffer.toString(),
            },
          });
        assertVerification(
          null,
          res,
          null,
          contractAddress,
          defaultContractChain,
          "partial"
        );
        const isExist = fs.existsSync(
          path.join(
            server.repository,
            "contracts",
            "partial_match",
            defaultContractChain,
            contractAddress,
            "sources",
            "Storage.sol"
          )
        );
        chai.expect(isExist, "Files saved in the wrong directory").to.be.true;
      });
    });

    describe("solc v0.6.12 and v0.7.0 extra files in compilation causing metadata match but bytecode mismatch", function () {
      // Deploy the test contract locally
      // Contract from https://explorer.celo.org/address/0x923182024d0Fa5dEe59E3c3db5e2eeD23728D3C3/contracts
      let contractAddress;
      const bytecodeMismatchArtifact = require(path.join(
        __dirname,
        "./sources/artifacts/extraFilesBytecodeMismatch.json"
      ));

      before(async () => {
        contractAddress = await deployFromAbiAndBytecode(
          localSigner,
          bytecodeMismatchArtifact.abi,
          bytecodeMismatchArtifact.bytecode
        );
      });

      it("should warn the user about the issue when metadata match but not bytecodes", (done) => {
        const hardhatOutput = require(path.join(
          __dirname,
          "./sources/hardhat-output/extraFilesBytecodeMismatch-onlyMetadata.json"
        ));
        const hardhatOutputBuffer = Buffer.from(JSON.stringify(hardhatOutput));
        chai
          .request(server.app)
          .post("/")
          .field("chain", defaultContractChain)
          .field("address", contractAddress)
          .attach("files", hardhatOutputBuffer)
          .end((err, res) => {
            chai.expect(res.status).to.equal(500);
            chai.expect(res.body).to.deep.equal({
              error:
                "It seems your contract's metadata hashes match but not the bytecodes. You should add all the files input to the compiler during compilation and remove all others. See the issue for more information: https://github.com/ethereum/sourcify/issues/618",
            });
            done();
          });
      });

      it("should verify with all input files and not only those in metadata", (done) => {
        const hardhatOutput = require(path.join(
          __dirname,
          "./sources/hardhat-output/extraFilesBytecodeMismatch.json"
        ));
        const hardhatOutputBuffer = Buffer.from(JSON.stringify(hardhatOutput));
        chai
          .request(server.app)
          .post("/")
          .field("chain", defaultContractChain)
          .field("address", contractAddress)
          .attach("files", hardhatOutputBuffer)
          .end((err, res) => {
            assertVerification(
              err,
              res,
              done,
              contractAddress,
              defaultContractChain,
              "perfect"
            );
          });
      });
    });
  });

  describe("session api verification", function () {
    this.timeout(EXTENDED_TIME_60);

    it("should inform when no pending contracts", (done) => {
      chai
        .request(server.app)
        .post("/session/verify-validated")
        .send({})
        .end((err, res) => {
          chai.expect(err).to.be.null;
          chai.expect(res.body).to.haveOwnProperty("error");
          chai.expect(res.status).to.equal(StatusCodes.BAD_REQUEST);
          chai
            .expect(res.body.error)
            .to.equal("There are currently no pending contracts.");
          done();
        });
    });

    const assertAddressAndChainMissing = (
      res,
      expectedFound,
      expectedMissing
    ) => {
      chai.expect(res.status).to.equal(StatusCodes.OK);
      const contracts = res.body.contracts;
      chai.expect(contracts).to.have.a.lengthOf(1);

      const contract = contracts[0];
      chai.expect(contract.status).to.equal("error");
      chai.expect(contract.files.missing).to.deep.equal(expectedMissing);
      chai.expect(contract.files.found).to.deep.equal(expectedFound);
      chai.expect(res.body.unused).to.be.empty;
      chai.expect(contract.storageTimestamp).to.equal(undefined);
      return contracts;
    };

    it("should accept file upload in JSON format", (done) => {
      chai
        .request(server.app)
        .post("/session/input-files")
        .send({
          files: {
            "metadata.json": metadataBuffer.toString(),
            "Storage.sol": sourceBuffer.toString(),
          },
        })
        .then((res) => {
          assertAddressAndChainMissing(
            res,
            ["project:/contracts/Storage.sol"],
            {}
          );
          done();
        });
    });

    it("should not verify after addition of metadata+source, but should after providing address+chainId", (done) => {
      const agent = chai.request.agent(server.app);
      agent
        .post("/session/input-files")
        .attach("files", sourceBuffer, "Storage.sol")
        .attach("files", metadataBuffer, "metadata.json")
        .then((res) => {
          const contracts = assertAddressAndChainMissing(
            res,
            ["project:/contracts/Storage.sol"],
            {}
          );
          contracts[0].address = defaultContractAddress;
          contracts[0].chainId = defaultContractChain;

          agent
            .post("/session/verify-validated")
            .send({ contracts })
            .end((err, res) => {
              assertVerificationSession(
                err,
                res,
                done,
                defaultContractAddress,
                defaultContractChain,
                "perfect"
              );
            });
        });
    });

    const assertAfterMetadataUpload = (err, res) => {
      chai.expect(err).to.be.null;
      chai.expect(res.status).to.equal(StatusCodes.OK);
      chai.expect(res.body.unused).to.be.empty;

      const contracts = res.body.contracts;
      chai.expect(contracts).to.have.a.lengthOf(1);
      const contract = contracts[0];

      chai.expect(contract.name).to.equal("Storage");
      chai.expect(contract.status).to.equal("error");
    };

    it("should not verify when session cookie not stored clientside", (done) => {
      chai
        .request(server.app)
        .post("/session/input-files")
        .attach("files", metadataBuffer, "metadata.json")
        .end((err, res) => {
          assertAfterMetadataUpload(err, res);

          chai
            .request(server.app)
            .post("/session/input-files")
            .attach("files", sourceBuffer, "Storage.sol")
            .end((err, res) => {
              chai.expect(err).to.be.null;
              chai.expect(res.status).to.equal(StatusCodes.OK);

              chai.expect(res.body.unused).to.deep.equal(["Storage.sol"]);
              chai.expect(res.body.contracts).to.be.empty;
              done();
            });
        });
    });

    it("should verify when session cookie stored clientside", (done) => {
      const agent = chai.request.agent(server.app);
      agent
        .post("/session/input-files")
        .attach("files", metadataBuffer, "metadata.json")
        .end((err, res) => {
          assertAfterMetadataUpload(err, res);
          const contracts = res.body.contracts;

          agent
            .post("/session/input-files")
            .attach("files", sourceBuffer, "Storage.sol")
            .end((err, res) => {
              contracts[0].chainId = defaultContractChain;
              contracts[0].address = defaultContractAddress;
              assertVerificationSession(
                err,
                res,
                null,
                undefined,
                undefined,
                "error"
              );

              agent
                .post("/session/verify-validated")
                .send({ contracts })
                .end((err, res) => {
                  assertVerificationSession(
                    err,
                    res,
                    done,
                    defaultContractAddress,
                    defaultContractChain,
                    "perfect"
                  );
                });
            });
        });
    });

    it("should fail with HTTP 413 if a file above max server file size is uploaded", (done) => {
      const agent = chai.request.agent(server.app);
      const file = "a".repeat(MAX_FILE_SIZE + 1);
      agent
        .post("/session/input-files")
        .attach("files", Buffer.from(file))
        .then((res) => {
          chai.expect(res.status).to.equal(StatusCodes.REQUEST_TOO_LONG);
          done();
        });
    });

    it("should fail if too many files uploaded, but should succeed after deletion", async () => {
      const agent = chai.request.agent(server.app);
      let res;
      const maxNumMaxFiles = Math.floor(MAX_SESSION_SIZE / MAX_FILE_SIZE); // Max number of max size files allowed in a session
      const file = "a".repeat((MAX_FILE_SIZE * 3) / 4); // because of base64 encoding which increases size by 1/3, making it 4/3 of the original
      for (let i = 0; i < maxNumMaxFiles; i++) {
        // Should be allowed each time
        res = await agent
          .post("/session/input-files")
          .attach("files", Buffer.from(file));
        chai.expect(res.status).to.equal(StatusCodes.OK);
      }
      // Should exceed size this time
      res = await agent
        .post("/session/input-files")
        .attach("files", Buffer.from(file));
      chai.expect(res.status).to.equal(StatusCodes.REQUEST_TOO_LONG);
      chai.expect(res.body.error).to.exist;
      // Should be back to normal
      res = await agent.post("/session/clear");
      chai.expect(res.status).to.equal(StatusCodes.OK);
      res = await agent
        .post("/session/input-files")
        .attach("files", Buffer.from("a"));
      chai.expect(res.status).to.equal(StatusCodes.OK);
      console.log("done");
    });

    const assertSingleContractStatus = (
      res,
      expectedStatus,
      shouldHaveTimestamp
    ) => {
      chai.expect(res.status).to.equal(StatusCodes.OK);
      chai.expect(res.body).to.haveOwnProperty("contracts");
      const contracts = res.body.contracts;
      chai.expect(contracts).to.have.a.lengthOf(1);
      const contract = contracts[0];
      chai.expect(contract.status).to.equal(expectedStatus);
      chai.expect(!!contract.storageTimestamp).to.equal(!!shouldHaveTimestamp);
      return contracts;
    };

    it("should verify after providing address and then network; should provide timestamp when verifying again", (done) => {
      const agent = chai.request.agent(server.app);
      agent
        .post("/session/input-files")
        .attach("files", sourceBuffer)
        .attach("files", metadataBuffer)
        .then((res) => {
          const contracts = assertSingleContractStatus(res, "error");
          contracts[0].address = defaultContractAddress;

          agent
            .post("/session/verify-validated")
            .send({ contracts })
            .then((res) => {
              assertSingleContractStatus(res, "error");
              contracts[0].chainId = defaultContractChain;

              agent
                .post("/session/verify-validated")
                .send({ contracts })
                .then((res) => {
                  assertSingleContractStatus(res, "perfect");

                  agent
                    .post("/session/verify-validated")
                    .send({ contracts })
                    .then((res) => {
                      assertSingleContractStatus(res, "perfect", true);
                      done();
                    });
                });
            });
        });
    });

    it("should fail for a source that is missing and unfetchable", (done) => {
      const agent = chai.request.agent(server.app);
      agent
        .post("/session/input-files")
        .attach("files", modifiedIpfsMetadataBuffer)
        .then((res) => {
          assertAddressAndChainMissing(res, [], {
            "project:/contracts/Storage.sol": {
              keccak256:
                "0x88c47206b5ec3d60ab820e9d126c4ac54cb17fa7396ff49ebe27db2862982ad8",
              urls: [
                "bzz-raw://5d1eeb01c8c10bed9e290f4a80a8d4081422a7b298a13049d72867022522cf6b",
                "dweb:/ipfs/QmaFRC9ZtT7y3t9XNWCbDuMTEwKkyaQJzYFzw3NbeohSna", // last char changed to "a"
              ],
            },
          });
          done();
        });
    });

    it("should fetch missing sources", (done) => {
      const agent = chai.request.agent(server.app);
      agent.post("/session/clear").then((res) => {
        agent
          .post("/session/input-files")
          .attach("files", metadataBuffer)
          .then((res) => {
            assertAddressAndChainMissing(
              res,
              ["project:/contracts/Storage.sol"],
              {}
            );
            done();
          });
      });
    });

    it("should verify after fetching and then providing address+chainId", (done) => {
      const agent = chai.request.agent(server.app);
      agent
        .post("/session/input-files")
        .attach("files", metadataBuffer)
        .then((res) => {
          const contracts = assertAddressAndChainMissing(
            res,
            ["project:/contracts/Storage.sol"],
            {}
          );
          contracts[0].address = defaultContractAddress;
          contracts[0].chainId = defaultContractChain;

          agent
            .post("/session/verify-validated")
            .send({ contracts })
            .then((res) => {
              assertSingleContractStatus(res, "perfect");
              done();
            });
        });
    });

    it("should correctly handle when uploaded 0/2 and then 1/2 sources", (done) => {
      const metadataPath = path.join(
        __dirname,
        "sources",
        "metadata",
        "child-contract.meta.object.json"
      );
      const metadataBuffer = fs.readFileSync(metadataPath);

      const parentPath = path.join(
        __dirname,
        "sources",
        "contracts",
        "ParentContract.sol"
      );
      const parentBuffer = fs.readFileSync(parentPath);

      const agent = chai.request.agent(server.app);
      agent
        .post("/session/input-files")
        .attach("files", metadataBuffer)
        .then((res) => {
          chai.expect(res.status).to.equal(StatusCodes.OK);
          chai.expect(res.body.contracts).to.have.lengthOf(1);
          chai.expect(res.body.unused).to.be.empty;

          const contract = res.body.contracts[0];
          chai.expect(contract.files.found).to.have.lengthOf(0);
          chai.expect(Object.keys(contract.files.missing)).to.have.lengthOf(2);

          agent
            .post("/session/input-files")
            .attach("files", parentBuffer)
            .then((res) => {
              chai.expect(res.status).to.equal(StatusCodes.OK);
              chai.expect(res.body.contracts).to.have.lengthOf(1);
              chai.expect(res.body.unused).to.be.empty;

              const contract = res.body.contracts[0];
              chai.expect(contract.files.found).to.have.lengthOf(1);
              chai
                .expect(Object.keys(contract.files.missing))
                .to.have.lengthOf(1);

              done();
            });
        });
    });

    it("should find contracts in a zipped Truffle project", (done) => {
      const zippedTrufflePath = path.join(
        __dirname,
        "sources",
        "truffle",
        "truffle-example.zip"
      );
      const zippedTruffleBuffer = fs.readFileSync(zippedTrufflePath);
      chai
        .request(server.app)
        .post("/session/input-files")
        .attach("files", zippedTruffleBuffer)
        .then((res) => {
          chai.expect(res.status).to.equal(StatusCodes.OK);
          chai.expect(res.body.contracts).to.have.lengthOf(3);
          done();
        });
      it("should correctly handle when uploaded 0/2 and then 1/2 sources", (done) => {
        const metadataPath = path.join(
          __dirname,
          "sources",
          "metadata",
          "child-contract.meta.object.json"
        );
        const metadataBuffer = fs.readFileSync(metadataPath);

        const parentPath = path.join(
          __dirname,
          "sources",
          "contracts",
          "ParentContract.sol"
        );
        const parentBuffer = fs.readFileSync(parentPath);

        const agent = chai.request.agent(server.app);
        agent
          .post("/session/input-files")
          .attach("files", metadataBuffer)
          .then((res) => {
            chai.expect(res.status).to.equal(StatusCodes.OK);
            chai.expect(res.body.contracts).to.have.lengthOf(1);
            chai.expect(res.body.unused).to.be.empty;

            const contract = res.body.contracts[0];
            chai.expect(contract.files.found).to.have.lengthOf(0);
            chai.expect(contract.files.missing).to.have.lengthOf(2);

            agent
              .post("/session/input-files")
              .attach("files", parentBuffer)
              .then((res) => {
                chai.expect(res.status).to.equal(StatusCodes.OK);
                chai.expect(res.body.contracts).to.have.lengthOf(1);
                chai.expect(res.body.unused).to.be.empty;

                const contract = res.body.contracts[0];
                chai.expect(contract.files.found).to.have.lengthOf(1);
                chai.expect(contract.files.missing).to.have.lengthOf(1);

                done();
              });
          });
      });

      it("should find contracts in a zipped Truffle project", (done) => {
        const zippedTrufflePath = path.join(
          __dirname,
          "sources",
          "truffle",
          "truffle-example.zip"
        );
        const zippedTruffleBuffer = fs.readFileSync(zippedTrufflePath);
        chai
          .request(server.app)
          .post("/session/input-files")
          .attach("files", zippedTruffleBuffer)
          .then((res) => {
            chai.expect(res.status).to.equal(StatusCodes.OK);
            chai.expect(res.body.contracts).to.have.lengthOf(3);
            chai.expect(res.body.unused).to.be.empty;
            done();
          });
      });
    });

    it("should verify a contract with immutables and save immutable-references.json", async () => {
      const artifact = require(path.join(
        __dirname,
        "./testcontracts/WithImmutables/artifact.json"
      ));
      const { contractAddress } =
        await deployFromAbiAndBytecodeForCreatorTxHash(
          localSigner,
          artifact.abi,
          artifact.bytecode,
          [999]
        );

      const metadata = require(path.join(
        __dirname,
        "./testcontracts/WithImmutables/metadata.json"
      ));
      const metadataBuffer = Buffer.from(JSON.stringify(metadata));
      const sourcePath = path.join(
        __dirname,
        "testcontracts",
        "WithImmutables",
        "sources",
        "WithImmutables.sol"
      );
      const sourceBuffer = fs.readFileSync(sourcePath);

      const agent = chai.request.agent(server.app);

      const res1 = await agent
        .post("/session/input-files")
        .attach("files", sourceBuffer)
        .attach("files", metadataBuffer);

      let contracts = assertSingleContractStatus(res1, "error");

      contracts[0].address = contractAddress;
      contracts[0].chainId = defaultContractChain;
      const res2 = await agent
        .post("/session/verify-validated")
        .send({ contracts });

      assertSingleContractStatus(res2, "perfect");
      const isExist = fs.existsSync(
        path.join(
          server.repository,
          "contracts",
          "full_match",
          defaultContractChain,
          contractAddress,
          "immutable-references.json"
        )
      );
      chai.expect(isExist, "Immutable references not saved").to.be.true;
    });

    it("should verify a contract created by a factory contract and has immutables", async () => {
      const deployValue = 12345;

      const artifact = require(path.join(
        __dirname,
        "./testcontracts/FactoryImmutable/Factory.json"
      ));
      const factoryAddress = await deployFromAbiAndBytecode(
        localSigner,
        artifact.abi,
        artifact.bytecode
      );

      // Deploy child by calling deploy(uint)
      const childMetadata = require(path.join(
        __dirname,
        "./testcontracts/FactoryImmutable/Child_metadata.json"
      ));
      const childMetadataBuffer = Buffer.from(JSON.stringify(childMetadata));
      const txReceipt = await callContractMethodWithTx(
        localSigner,
        artifact.abi,
        factoryAddress,
        "deploy",
        [deployValue]
      );

      const childAddress = txReceipt.logs[0].args[0];
      const sourcePath = path.join(
        __dirname,
        "testcontracts",
        "FactoryImmutable",
        "FactoryTest.sol"
      );
      const sourceBuffer = fs.readFileSync(sourcePath);

      const agent = chai.request.agent(server.app);

      const res1 = await agent
        .post("/session/input-files")
        .attach("files", sourceBuffer)
        .attach("files", childMetadataBuffer);

      const contracts = assertSingleContractStatus(res1, "error");

      contracts[0].address = childAddress;
      contracts[0].chainId = defaultContractChain;

      const res = await agent
        .post("/session/verify-validated")
        .send({ contracts });
      assertSingleContractStatus(res, "perfect");
    });

    it("should verify a contract created by a factory contract and has immutables without constructor arguments but with msg.sender assigned immutable", async () => {
      const artifact = require(path.join(
        __dirname,
        "./testcontracts/FactoryImmutableWithoutConstrArg/Factory3.json"
      ));
      const factoryAddress = await deployFromAbiAndBytecode(
        localSigner,
        artifact.abi,
        artifact.bytecode
      );

      // Deploy child by calling deploy(uint)
      const childMetadata = require(path.join(
        __dirname,
        "./testcontracts/FactoryImmutableWithoutConstrArg/Child3_metadata.json"
      ));
      const childMetadataBuffer = Buffer.from(JSON.stringify(childMetadata));
      const txReceipt = await callContractMethodWithTx(
        localSigner,
        artifact.abi,
        factoryAddress,
        "createChild",
        []
      );

      const childAddress = txReceipt.logs[0].args[0];
      const sourcePath = path.join(
        __dirname,
        "testcontracts",
        "FactoryImmutableWithoutConstrArg",
        "FactoryTest3.sol"
      );
      const sourceBuffer = fs.readFileSync(sourcePath);

      const agent = chai.request.agent(server.app);

      const res1 = await agent
        .post("/session/input-files")
        .attach("files", sourceBuffer)
        .attach("files", childMetadataBuffer);

      const contracts = assertSingleContractStatus(res1, "error");

      contracts[0].address = childAddress;
      contracts[0].chainId = defaultContractChain;
      const res = await agent
        .post("/session/verify-validated")
        .send({ contracts });
      assertSingleContractStatus(res, "perfect");
    });

    it("should return validation error for adding standard input JSON without a compiler version", async () => {
      const agent = chai.request.agent(server.app);

      const solcJsonPath = path.join(
        __dirname,
        "testcontracts",
        "Storage",
        "StorageJsonInput.json"
      );
      const solcJsonBuffer = fs.readFileSync(solcJsonPath);

      const res = await agent
        .post("/session/input-solc-json")
        .attach("files", solcJsonBuffer);

      assertValidationError(null, res, "compilerVersion");
    });

    it("should verify a contract with Solidity standard input JSON", async () => {
      const agent = chai.request.agent(server.app);
      const address = await deployFromAbiAndBytecode(
        localSigner,
        artifact.abi, // Storage.sol
        artifact.bytecode
      );
      const solcJsonPath = path.join(
        __dirname,
        "testcontracts",
        "Storage",
        "StorageJsonInput.json"
      );
      const solcJsonBuffer = fs.readFileSync(solcJsonPath);

      const res = await agent
        .post("/session/input-solc-json")
        .field("compilerVersion", "0.8.4+commit.c7e474f2")
        .attach("files", solcJsonBuffer, "solc.json");

      const contracts = assertSingleContractStatus(res, "error");

      contracts[0].address = address;
      contracts[0].chainId = defaultContractChain;

      const res2 = await agent
        .post("/session/verify-validated")
        .send({ contracts });
      assertSingleContractStatus(res2, "perfect");
    });

    // Test also extra-file-bytecode-mismatch via v2 API as well since the workaround is at the API level i.e. VerificationController
    describe("solc v0.6.12 and v0.7.0 extra files in compilation causing metadata match but bytecode mismatch", function () {
      // Deploy the test contract locally
      // Contract from https://explorer.celo.org/address/0x923182024d0Fa5dEe59E3c3db5e2eeD23728D3C3/contracts
      let contractAddress;
      const bytecodeMismatchArtifact = require(path.join(
        __dirname,
        "./sources/artifacts/extraFilesBytecodeMismatch.json"
      ));

      before(async () => {
        contractAddress = await deployFromAbiAndBytecode(
          localSigner,
          bytecodeMismatchArtifact.abi,
          bytecodeMismatchArtifact.bytecode
        );
      });

      it("should warn the user about the issue when metadata match but not bytecodes", (done) => {
        const hardhatOutput = require(path.join(
          __dirname,
          "./sources/hardhat-output/extraFilesBytecodeMismatch-onlyMetadata.json"
        ));
        const hardhatOutputBuffer = Buffer.from(JSON.stringify(hardhatOutput));

        const agent = chai.request.agent(server.app);
        agent
          .post("/session/input-files")
          .attach("files", hardhatOutputBuffer)
          .then((res) => {
            const contracts = res.body.contracts;
            contracts[0].address = contractAddress;
            contracts[0].chainId = defaultContractChain;
            agent
              .post("/session/verify-validated")
              .send({ contracts })
              .then((res) => {
                assertSingleContractStatus(res, "error");
                done();
              });
          });
      });

      it("should verify with all input files and not only those in metadata", (done) => {
        const hardhatOutput = require(path.join(
          __dirname,
          "./sources/hardhat-output/extraFilesBytecodeMismatch.json"
        ));
        const hardhatOutputBuffer = Buffer.from(JSON.stringify(hardhatOutput));

        const agent = chai.request.agent(server.app);
        agent
          .post("/session/input-files")
          .attach("files", hardhatOutputBuffer)
          .then((res) => {
            const contracts = res.body.contracts;
            contracts[0].address = contractAddress;
            contracts[0].chainId = defaultContractChain;
            agent
              .post("/session/verify-validated")
              .send({ contracts })
              .then((res) => {
                assertSingleContractStatus(res, "perfect");
                done();
              });
          });
      });
    });
  });
  describe("E2E test path sanitization", async function () {
    it("should verify a contract with paths containing misc. chars, save the path translation, and be able access the file over the API", async () => {
      const sanitizeArtifact = require(path.join(
        __dirname,
        "./testcontracts/path-sanitization/ERC20.json"
      ));
      const sanitizeMetadata = require(path.join(
        __dirname,
        "./testcontracts/path-sanitization/metadata.json"
      ));
      // read all files under test/testcontracts/path-sanitization/sources/ and put them in an object
      const sanitizeSourcesObj = {};
      fs.readdirSync(
        path.join(__dirname, "testcontracts", "path-sanitization", "sources")
      ).forEach(
        (fileName) =>
          (sanitizeSourcesObj[fileName] = fs.readFileSync(
            path.join(
              __dirname,
              "testcontracts",
              "path-sanitization",
              "sources",
              fileName
            )
          ))
      );

      const sanitizeMetadataBuffer = Buffer.from(
        JSON.stringify(sanitizeMetadata)
      );

      const toBeSanitizedContractAddress = await deployFromAbiAndBytecode(
        localSigner,
        sanitizeArtifact.abi,
        sanitizeArtifact.bytecode,
        ["TestToken", "TEST", 1000000000]
      );

      const verificationResponse = await chai
        .request(server.app)
        .post("/")
        .send({
          address: toBeSanitizedContractAddress,
          chain: defaultContractChain,
          files: {
            "metadata.json": sanitizeMetadataBuffer.toString(),
            ...sanitizeSourcesObj,
          },
        });

      chai.expect(verificationResponse.status).to.equal(StatusCodes.OK);
      chai
        .expect(verificationResponse.body.result[0].status)
        .to.equal("perfect");
      const contractSavedPath = path.join(
        server.repository,
        "contracts",
        "full_match",
        defaultContractChain,
        toBeSanitizedContractAddress
      );
      const pathTranslationPath = path.join(
        contractSavedPath,
        "path-translation.json"
      );

      let pathTranslationJSON;
      try {
        pathTranslationJSON = JSON.parse(
          fs.readFileSync(pathTranslationPath).toString()
        );
      } catch (e) {
        throw new Error(
          `Path translation file not found at ${pathTranslationPath}`
        );
      }

      // Get the contract files from the server
      const res = await chai
        .request(server.app)
        .get(`/files/${defaultContractChain}/${toBeSanitizedContractAddress}`);
      chai.expect(res.status).to.equal(StatusCodes.OK);

      // The translation path must inlude the new translated path
      const fetchedContractFiles = res.body;
      Object.keys(pathTranslationJSON).forEach((originalPath) => {
        // The metadata must have the original path
        chai
          .expect(
            sanitizeMetadata.sources,
            `Original path ${originalPath} not found in metadata`
          )
          .to.include.key(originalPath);
        // The path from the server response must be translated
        const translatedContractObject = fetchedContractFiles.find(
          (obj) =>
            obj.path ===
            path.join(
              contractSavedPath,
              "sources",
              pathTranslationJSON[originalPath]
            )
        );
        chai.expect(translatedContractObject).to.exist;
        // And the saved file must be the same as in the metadata
        chai
          .expect(
            sanitizeMetadata.sources[originalPath].keccak256,
            `Keccak of ${originalPath} does not match ${translatedContractObject.path}`
          )
          .to.equal(keccak256str(translatedContractObject.content));
      });
    });

    it("should not save path translation if the path is not sanitized", async () => {
      const contractAddress = await deployFromAbiAndBytecode(
        localSigner,
        artifact.abi,
        artifact.bytecode
      );
      await chai
        .request(server.app)
        .post("/")
        .send({
          address: defaultContractAddress,
          chain: defaultContractChain,
          files: {
            "metadata.json": metadataBuffer,
            "Storage.sol": sourceBuffer,
          },
        })
        .end((err, res) =>
          assertVerification(
            err,
            res,
            null,
            defaultContractAddress,
            defaultContractChain,
            "perfect"
          )
        );
      const contractSavedPath = path.join(
        server.repository,
        "contracts",
        "full_match",
        defaultContractChain,
        contractAddress
      );
      const pathTranslationPath = path.join(
        contractSavedPath,
        "path-translation.json"
      );
      chai.expect(fs.existsSync(pathTranslationPath)).to.be.false;
    });
  });
  describe("Verify repository endpoints", function () {
    const agent = chai.request.agent(server.app);
    it("should fetch files of specific address", async function () {
      // Wait for the server to complete the previous contract verification
      await waitSecs(1);
      const res = await agent
        .post("/")
        .field("address", defaultContractAddress)
        .field("chain", defaultContractChain)
        .attach("files", metadataBuffer, "metadata.json")
        .attach("files", sourceBuffer, "Storage.sol");
      console.log(res.body);
      const res0 = await agent.get(
        `/files/${defaultContractChain}/${defaultContractAddress}`
      );
      chai.expect(res0.body).has.a.lengthOf(2);
      const res1 = await agent.get(
        `/files/tree/any/${defaultContractChain}/${defaultContractAddress}`
      );
      chai.expect(res1.body?.status).equals("full");
      const res2 = await agent.get(
        `/files/any/${defaultContractChain}/${defaultContractAddress}`
      );
      chai.expect(res2.body?.status).equals("full");
      const res3 = await agent.get(
        `/files/tree/${defaultContractChain}/${defaultContractAddress}`
      );
      chai.expect(res3.body).has.a.lengthOf(2);
      const res4 = await agent.get(`/files/contracts/${defaultContractChain}`);
      chai.expect(res4.body.full).has.a.lengthOf(1);
    });
  });
  describe("Verify server status endpoint", function () {
    it("should check server's health", async function () {
      const res = await chai.request(server.app).get("/health");
      chai.expect(res.text).equals("Alive and kicking!");
    });
    it("should check server's chains", async function () {
      const res = await chai.request(server.app).get("/chains");
      chai.expect(res.body.length).greaterThan(0);
    });
  });
  describe("Unit test functions", function () {
    this.timeout(EXTENDED_TIME_60);
    const { sourcifyChainsArray } = require("../dist/sourcify-chains");
    const {
      getCreatorTx,
    } = require("../dist/server/services/utils/contract-creation-util");
    it("should run getCreatorTx with chainId 40", async function () {
      const sourcifyChain = sourcifyChainsArray.find(
        (sourcifyChain) => sourcifyChain.chainId === 40
      );
      const creatorTx = await getCreatorTx(
        sourcifyChain,
        "0x4c09368a4bccD1675F276D640A0405Efa9CD4944"
      );
      chai
        .expect(creatorTx)
        .equals(
          "0xb7efb33c736b1e8ea97e356467f99d99221343f077ce31a3e3ac1d2e0636df1d"
        );
    });
    // Commented out as fails way too often
    // it("should run getCreatorTx with chainId 51", async function () {
    //   const sourcifyChain = sourcifyChainsArray.find(
    //     (sourcifyChain) => sourcifyChain.chainId === 51
    //   );
    //   const creatorTx = await getCreatorTx(
    //     sourcifyChain,
    //     "0x8C3FA94eb5b07c9AF7dBFcC53ea3D2BF7FdF3617"
    //   );
    //   chai
    //     .expect(creatorTx)
    //     .equals(
    //       "0xb1af0ec1283551480ae6e6ce374eb4fa7d1803109b06657302623fc65c987420"
    //     );
    // });
    it("should run getCreatorTx with chainId 83", async function () {
      const sourcifyChain = sourcifyChainsArray.find(
        (sourcifyChain) => sourcifyChain.chainId === 83
      );
      const creatorTx = await getCreatorTx(
        sourcifyChain,
        "0x89e772941d94Ef4BDA1e4f68E79B4bc5F6096389"
      );
      chai
        .expect(creatorTx)
        .equals(
          "0x8cc7b0fb66eaf7b32bac7b7938aedfcec6d49f9fe607b8008a5541e72d264069"
        );
    });
    it("should run getCreatorTx with chainId 335", async function () {
      const sourcifyChain = sourcifyChainsArray.find(
        (sourcifyChain) => sourcifyChain.chainId === 335
      );
      const creatorTx = await getCreatorTx(
        sourcifyChain,
        "0x40D843D06dAC98b2586fD1DFC5532145208C909F"
      );
      chai
        .expect(creatorTx)
        .equals(
          "0xd125cc92f61d0898d55a918283f8b855bde15bc5f391b621e0c4eee25c9997ee"
        );
    });
    it("should run getCreatorTx with regex for new Blockscout", async function () {
      const sourcifyChain = sourcifyChainsArray.find(
        (sourcifyChain) => sourcifyChain.chainId === 100
      );
      const creatorTx = await getCreatorTx(
        sourcifyChain,
        "0x3CE1a25376223695284edc4C2b323C3007010C94"
      );
      chai
        .expect(creatorTx)
        .equals(
          "0x11da550e6716be8b4bd9203cb384e89b8f8941dc460bd99a4928ce2825e05456"
        );
    });
    it("should run getCreatorTx with regex for old Blockscout", async function () {
      const sourcifyChain = sourcifyChainsArray.find(
        (sourcifyChain) => sourcifyChain.chainId === 1313161554
      );
      const creatorTx = await getCreatorTx(
        sourcifyChain,
        "0x2CB45Edb4517d5947aFdE3BEAbF95A582506858B"
      );
      chai
        .expect(creatorTx)
        .equals(
          "0x8fbcf663b8d86af936d5a72cbf9e6becd17e87e167bdcff449663e987cf09759"
        );
    });
    it("should run getCreatorTx with regex for Etherscan", async function () {
      const sourcifyChain = sourcifyChainsArray.find(
        (sourcifyChain) => sourcifyChain.chainId === 84531
      );
      const creatorTx = await getCreatorTx(
        sourcifyChain,
        "0xbe92671bdd1a1062e1a9f3be618e399fb5facace"
      );
      chai
        .expect(creatorTx)
        .equals(
          "0x15c5208cacbc1e14d9906926b8a991ec986a442f26081fe5ac9de4eb671c5195"
        );
    });
  });

  describe("Database", function () {
    this.timeout(20000);
    const storageService = new StorageService({
      repositoryV1ServiceOptions: {
        ipfsApi: process.env.IPFS_API,
        repositoryPath: "./dist/data/mock-repositoryV1",
        repositoryServerUrl: config.get("repositoryV1.serverUrl"),
      },
      sourcifyDatabaseServiceOptions: {
        postgres: {
          host: "localhost",
          database: "sourcify",
          user: "sourcify",
          password: "sourcify",
          port: process.env.DOCKER_HOST_POSTGRES_TEST_PORT || 5431,
        },
      },
    });
    this.beforeEach(async () => {
      await storageService.sourcifyDatabase.init();
      await storageService.sourcifyDatabase.databasePool.query(
        "DELETE FROM sourcify_matches"
      );
      await storageService.sourcifyDatabase.databasePool.query(
        "DELETE FROM verified_contracts"
      );
      await storageService.sourcifyDatabase.databasePool.query(
        "DELETE FROM contract_deployments"
      );
      await storageService.sourcifyDatabase.databasePool.query(
        "DELETE FROM compiled_contracts"
      );
      await storageService.sourcifyDatabase.databasePool.query(
        "DELETE FROM contracts"
      );
      await storageService.sourcifyDatabase.databasePool.query(
        "DELETE FROM code"
      );
    });

    it("storeMatch", async () => {
      // Prepare the CheckedContract
      const checkedContract = createCheckedContract(
        _checkedContract.metadata,
        _checkedContract.solidity,
        _checkedContract.missing,
        _checkedContract.invalid
      );
      checkedContract.creationBytecode = _checkedContract.creationBytecode;
      checkedContract.runtimeBytecode = _checkedContract.runtimeBytecode;
      checkedContract.compilerOutput = _checkedContract.compilerOutput;
      checkedContract.creationBytecodeCborAuxdata =
        _checkedContract.creationBytecodeCborAuxdata;
      checkedContract.runtimeBytecodeCborAuxdata =
        _checkedContract.runtimeBytecodeCborAuxdata;

      // Call storeMatch
      await storageService.storeMatch(checkedContract, match);

      const res = await storageService.sourcifyDatabase.databasePool.query(
        "SELECT * FROM sourcify_matches"
      );

      if (res.rowCount === 1) {
        chai.expect(res.rows[0].runtime_match).to.equal("partial");
      }
    });

    const verifierAllianceTestLibrariesManuallyLinked = require("./verifier-alliance/libraries_manually_linked.json");
    it(verifierAllianceTestLibrariesManuallyLinked._comment, async () => {
      await verifierAllianceTest(
        server,
        chai,
        storageService,
        localSigner,
        defaultContractChain,
        verifierAllianceTestLibrariesManuallyLinked
      );
    });

    const verifierAllianceTestFullMatch = require("./verifier-alliance/full_match.json");
    it(verifierAllianceTestFullMatch._comment, async () => {
      await verifierAllianceTest(
        server,
        chai,
        storageService,
        localSigner,
        defaultContractChain,
        verifierAllianceTestFullMatch
      );
    });

    const verifierAllianceTestImmutables = require("./verifier-alliance/immutables.json");
    it(verifierAllianceTestImmutables._comment, async () => {
      await verifierAllianceTest(
        server,
        chai,
        storageService,
        localSigner,
        defaultContractChain,
        verifierAllianceTestImmutables
      );
    });

    const verifierAllianceTestLibrariesLinkedByCompiler = require("./verifier-alliance/libraries_linked_by_compiler.json");
    it(verifierAllianceTestLibrariesLinkedByCompiler._comment, async () => {
      await verifierAllianceTest(
        server,
        chai,
        storageService,
        localSigner,
        defaultContractChain,
        verifierAllianceTestLibrariesLinkedByCompiler
      );
    });

    const verifierAllianceTestMetadataHashAbsent = require("./verifier-alliance/metadata_hash_absent.json");
    it(verifierAllianceTestMetadataHashAbsent._comment, async () => {
      await verifierAllianceTest(
        server,
        chai,
        storageService,
        localSigner,
        defaultContractChain,
        verifierAllianceTestMetadataHashAbsent
      );
    });

    const verifierAllianceTestPartialMatch = require("./verifier-alliance/partial_match.json");
    it(verifierAllianceTestPartialMatch._comment, async () => {
      await verifierAllianceTest(
        server,
        chai,
        storageService,
        localSigner,
        defaultContractChain,
        verifierAllianceTestPartialMatch
      );
    });

    const verifierAllianceTestConstructorArguments = require("./verifier-alliance/constructor_arguments.json");
    it(verifierAllianceTestConstructorArguments._comment, async () => {
      await verifierAllianceTest(
        server,
        chai,
        storageService,
        localSigner,
        defaultContractChain,
        verifierAllianceTestConstructorArguments,
        { deployWithConstructorArguments: true }
      );
    });

    // Tests to be implemented:
    // - genesis: right now not supported,
    // - partial_match_2: I don't know why we have this test
    // - partial_match_double_auxdata: right now not supported
  });
});
