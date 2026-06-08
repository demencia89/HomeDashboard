# Changelog

## 0.1.2 - 2026-06-08

### Added

- Battery telemetry and UI indicators for devices that expose generic Linux, Termux-compatible, Android shell, UPower, or ACPI battery data.
- Battery display in sidebar server rows, fleet cards, and selected-server overview metrics.
- Offline Retry action in the selected-server header for forced fresh metrics collection.

### Changed

- Metrics streaming now reuses pooled SSH connections to reduce repeated login churn on monitored hosts.
- Forced metrics refresh drops the pooled SSH client before collecting again.
- Remote telemetry now sends the collector script over SSH stdin with `sh -s`, avoiding large inline command failures on constrained SSH servers.
- Local deployment helper paths are ignored by both Git and Docker build context rules.
- Post-0.1.1 UI polish for manual update messaging, theme picker styling, and container fleet card surfaces.

### Fixed

- Stale or closed pooled SSH sessions now retry once on a fresh connection before reporting a server offline.
- Hosts that rejected the large inline telemetry command, including appliance-style Raspberry Pi deployments, can report full metrics again.
- Generic Termux-compatible battery output is parsed without adding device-specific collector paths to HomeDashboard.
