<p align="center">
  <img src="https://github.com/can1357/oh-my-pi/blob/main/assets/hero.png?raw=true" alt="p247 Agent">
</p>

<p align="center">
  <strong>p247 — Autonomous High-Reliability AI Agent for Software Engineering</strong>
</p>

<p align="center">
  <a href="mailto:leonardovergaramarin@gmail.com"><img src="https://img.shields.io/badge/Contact-Leonardo%20Vergara-blue?style=flat&colorA=222222&colorB=007ACC" alt="Contact"></a>
  <a href="https://github.com/can1357/oh-my-pi/actions"><img src="https://img.shields.io/github/actions/workflow/status/can1357/oh-my-pi/ci.yml?style=flat&colorA=222222&colorB=3FB950" alt="CI"></a>
  <a href="https://github.com/can1357/oh-my-pi/blob/main/LICENSE"><img src="https://img.shields.io/github/license/can1357/oh-my-pi?style=flat&colorA=222222&colorB=58A6FF" alt="License"></a>
  <a href="https://www.typescriptlang.org"><img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&colorA=222222&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/Rust-DEA584?style=flat&colorA=222222&logo=rust&logoColor=white" alt="Rust"></a>
  <a href="https://bun.sh"><img src="https://img.shields.io/badge/runtime-Bun-f472b6?style=flat&colorA=222222" alt="Bun"></a>
</p>

<p align="center">
  Maintainer: <strong>Leonardo Vergara</strong> (<a href="mailto:leonardovergaramarin@gmail.com">leonardovergaramarin@gmail.com</a>)
  <br>
  Fork of <a href="https://github.com/can1357/oh-my-pi">oh-my-pi</a> by <a href="https://github.com/can1357">Can Bölük</a>
  <br>
  Lineage: oh-my-pi &larr; <a href="https://github.com/badlogic/pi-mono">pi-mono</a>
</p>

---

## Technical Overview

**p247** is a professional-grade evolution of the Pi coding agent, optimized for **autonomous reliability**, **operational safety**, and **remote oversight**. While inheriting the high-performance Rust engine and specialized toolset of its predecessors, p247 introduces a strict engineering methodology and automated supervision layer to ensure evidence-based results.

---

## Key Improvements (p247 Fork)

### + Verification Gate (Evidence-Based Engineering)

Mandates empirical proof for every modification. The agent is strictly prohibited from claiming a task is "fixed" without providing observable evidence.
- **Enforced Protocol**: End response with `VERIFICADO: [what] -> [result]` or `NO_VERIFICADO: [what]. RIESGO: [impact]`.
- **Automated Intervention**: Software-level gate in `agent-client.ts` that detects and rejects `VERIFICADO` declarations lacking real evidence (git diffs, test outputs, build logs).
- **Integrity**: Transforms the agent from an optimistic coder into a disciplined engineer.

### + Anti-Loop & Escalation Protocol

Prevents context exhaustion and resource waste caused by repetitive tool patterns.
- **Loop Detection**: Monitors tool call history for identical patterns (`tool(args)` repetition).
- **Stepped Intervention**: 
  - `EN_LOOP:1`: Automated system warning to change strategy immediately.
  - `EN_LOOP:2`: Final self-correction warning.
  - `ESCALANDO`: Automated escalation to the human operator with a clear explanation of the blocker.

### + Context Guard (Proactive Compaction)

Maintains high cognitive performance by preventing context saturation.
- **50% Threshold**: Proactive compaction triggers at 50% usage to ensure a deep reasoning window for complex tasks.
- **Stable History**: Preserves critical decision-making context while pruning redundant tool outputs.

### + Telegram & Email Gateway

Extends the agent's reach beyond the local terminal for asynchronous operation.
- **Remote Oversight**: Monitor agent progress, receive notifications, and provide input via Telegram or Email.
- **Autonomous Presence**: Enables the agent to act as a background "autonomous colleague" that updates you on task completion or blockers.

### + Senior Staff Identity & Methodology

The system prompt is re-engineered for a **Senior Staff Engineer** persona (direct, information-dense, no fluff).
- **Pareto 80/20**: Focus on the 20% of code causing 80% of the issue.
- **5 Whys**: Mandatory root cause discovery.
- **95% Certainty**: Research and verify before acting.
- **Isolated Workspace**: Dedicated `workspace/` for safe experiments and cloning without polluting source directories.

---

## Core Features (Inherited from oh-my-pi)

### + Native Performance Engine (Rust N-API)
High-performance bindings for `grep`, `glob`, `shell`, and `text` manipulation, powered by Rust internals for sub-second responses.

### + Hashline Edits
A surgical file editing system using short content-hash anchors. Guarantees precision, prevents ambiguous matches, and protects file integrity across 16+ benchmarked models.

### + Language Server Protocol (LSP)
Full IDE-like intelligence: `diagnostics`, `definition`, `references`, `hover`, and `code_actions` for 40+ languages.

### + Python IPython Kernel
Persistent execution environment with rich prelude helpers for data processing, file I/O, and Mermaid diagram rendering.

---

## Table of Contents

- [Installation](#installation)
- [Getting Started](#getting-started)
- [Usage](#usage)
  - [Slash Commands](#slash-commands)
  - [Bash Mode](#bash-mode)
  - [Telegram Gateway](#telegram-gateway)
- [Sessions & Compaction](#sessions--compaction)
- [Configuration](#configuration)
- [CLI Reference](#cli-reference)
- [Monorepo Packages](#monorepo-packages)
- [License](#license)

---

## Installation

### Via Bun (Recommended)
Requires [Bun](https://bun.sh) **>= 1.3.7**:
```bash
bun install -g .
```

### Deployment (p247 Service)
Includes a systemd service for persistent gateway operation:
```bash
# See packages/telegram-gateway/README.md for setup
cp packages/telegram-gateway/p247.service /etc/systemd/system/
```

---

## Getting Started

### 1) Configure Methodology
p247 follows a strict senior engineering persona. Use `/model` to assign high-reasoning models (like DeepSeek-R1 or Claude-3.5-Sonnet) to the `slow` and `plan` roles.

### 2) Using the Verification Gate
When the agent modifies a file, it **must** end the turn with a verification status. If it fails to do so, the Gateway will automatically prompt it to follow the protocol.

---

## Contact & Contribution

Project Lead: **Leonardo Vergara**
Email: [leonardovergaramarin@gmail.com](mailto:leonardovergaramarin@gmail.com)

Contributions focused on operational stability, security, and verification logic are welcome.

---

## License

MIT. See [LICENSE](LICENSE).

Copyright (c) 2025-2026 Leonardo Vergara
Copyright (c) 2025-2026 Can Bölük
Copyright (c) 2025 Mario Zechner
