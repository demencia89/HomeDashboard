# Changelog

## 1.2.3 - 2026-06-09

### Added

- WebSocket heartbeat cleanup, scoped WebSocket connection limits, and a debug endpoint for active WebSocket counts.

### Changed

- Metrics streams pause while the page is hidden or offline, reconnect with backoff, and refresh once when the page resumes.
- Pooled SSH metrics connections now rotate after a bounded lifetime while still avoiding repeated login churn.

### Fixed

- Stale metrics WebSockets can no longer consume all terminal connection capacity after a browser or network sleep.

## 0.1.2 - 2026-06-08

### Added

- Battery telemetry and UI indicators for devices that expose generic Linux, Termux-compatible, Android shell, UPower, or ACPI battery data.
- Battery display in sidebar server rows, selected-server headers, and fleet cards.
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
