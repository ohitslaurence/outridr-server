# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.4.1] - 2026-07-20

- Added `GET`/`PUT /repos/roots` so the outridr app can read and set
  `repos.roots` remotely for its onboarding flow. `PUT` requires a
  configured `token` (403 without one).

## [0.4.0] - 2026-07-20

### Breaking

- Removed `POST /exec` and the `repos.command` config option — the app now
  drives agents through herdr's native `worktree.create`/`agent.start` over
  `/herdr` instead of shelling out to a configured CLI.
- Added built-in git repo scanning (`repos.roots`, opt-in) replacing the
  external `repos.command` listing.

## [0.3.0] - 2026-07-19

- Added the package version to the `GET /health` response.
- Switched releases to tag-triggered npm publishing with npm trusted
  publishing (GitHub OIDC) and provenance — no long-lived npm token.

## [0.2.0] - 2026-07-17

- First npm release (`outridr@0.2.0`), published manually before trusted
  publishing was set up.
