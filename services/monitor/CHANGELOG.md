# Changelog for `sourcify-monitor`

All notable changes to this project will be documented in this file.

## sourcify-monitor@1.1.10 - 2024-03-14

- Rename chains.json to monitorChains.json

## sourcify-monitor@1.1.9 - 2024-02-26

- Make monitor Dockerfiles similar to server

## sourcify-monitor@1.1.8 - 2024-02-22

- Remove ethpandaops RPCs for Sepolia and Goerli temporarily.

## sourcify-monitor@1.1.7 - 2024-01-03

- Point dotenv to the correct file

## sourcify-monitor@1.1.6 - 2023-12-19

- Remove `version.ts` as this was causing a versioning loop.

## sourcify-monitor@1.1.5 - 2023-12-19

- Update monitor docker to use multi-stage builds and use bullseye-slim
- Fix notifying subscribers without trying next gateways in DecentralizedStorageFetcher
- Update README
- Remove localhosts from default chains
- Remove Typescript from dependencies and move to the project root

## sourcify-monitor@1.1.4 - 2023-11-23

- Update lib-sourcify

## sourcify-monitor@1.1.3 - 2023-11-03

- Monitor tests in js
- Fix `authenticateRpcs``

## sourcify-monitor@1.1.2 - 2023-10-23

- Handles Alchemy API keys for Optimism and Arbitrum

## sourcify-monitor@1.1.1 - 2023-10-19

- Bump to sync the tags on master

## sourcify-monitor@1.1.0 - 2023-10-18

- Add tests to sourcify-monitor
- Enable passing parameters other than `lastBlock` to each `ChainMonitor`

## sourcify-monitor@1.0.0 - 2023-10-09

No changes this release. This marks the start of the changelog for this module.

This was a total rewrite of the sourcify-monitor as a completely isolated module from the sourcify-server. Previously it was sharing the verification logic as well as the filesystem. The new sourcify-monitor will detect contract creations and send them to an existing sourcify server in HTTP requests. See the [README](./README.md) for more information.

## Older releases

Previously, the releases were not done one separate modules of Sourcify but for the repository as a whole.
You can find the changelog for those releases in [older releases](https://github.com/ethereum/sourcify/releases) for this repository.
