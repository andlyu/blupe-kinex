# Kinex × BluPe

Website source for https://kinex-blupe.andlyu.chatgpt.site. This is a real Kinex core/MCP integration with Astra through Codex, adapted to Robo-house YAM. Physical acceptance is pending; see the integration checklist.

The page displays real public robot camera frames, editable task/name/email, Run and Stop, actual tool activity, and retained run records. A Cloudflare Worker and D1 relay connect an outbound local Kinex worker without exposing subscription credentials, the robot session capability, or a local network port. Email remains in private run storage and is excluded from all public responses.

Shared runtime source belongs in [blupe-remote-bots/codex-runner](https://github.com/andlyu/blupe-remote-bots/tree/codex/kinex-playground/codex-runner). The integration's launcher, native device drivers, restricted Kinex MCP host, required offline release gate, and working acceptance checklist live under `codex-runner/integrations/kinex/`. No editable runner copy is bundled here. Replay errors expose the retained source link for another player; browser playback acceptance remains unchecked until observed.

The method is **Kinex**; underlying planning/vision model is configurable in the worker and defaults to the user-adopted `gpt-6-astra`, low reasoning. It uses the official Kinex MCP/core 1.0.0 snapshots from kinex-plugins revision `f68a8d7f1ddcae2b096f171b817c232d8730f3ec`, tested with Codex 0.162.1. There is no API-key or alternate-model fallback.

Initial capabilities are joint servo, normalized gripper buffers, measured feedback and RGB cameras. Cartesian goals, unrestricted Python/shell, and simultaneous/superseding actuator buffers are excluded. Every actuator command passes the existing BluPe queue/lease, startup readiness, canonical packet serialization, motion/safety limits and measured completion checks. Timeouts and unknown execution outcomes stop without automatic replay.

Run `npm run build` and `npm run validate` to check the website artifact. Deployment uses the Sites source workflow; D1 migrations are in `drizzle/`. Configure the `RUNNER_TOKEN` secret through Sites environment variables. Give the outbound worker the same private token through its mode-600 local token file. Never commit secrets, identity defaults, runtime logs or local state.

The user's November 12 request to launch the harness and make a new website invokes the copied BluPe harness authorization contract. It authorizes this integration's public source, public website and scoped robot verification. Hardware acceptance and replay/timing evidence remain unchecked until actually verified.

Recording discovery uses the public BluPe recording index for the exact episode, Robo-house and Model=Kinex, or an exact independently matched live queue context when the archive model is absent. Only matching approved BluPe/Hugging Face MP4 links become playable. Preparation, missing attribution and index failures remain visible and are checked again without rerunning hardware. Accelerated preview footage is labelled. Runner updates cannot inject a replay URL or erase a concurrently recovered recording. Eight offline Worker tests exercise the real SQLite queries; they do not prove physical footage exists.

The user selected Robo-house YAM, robot-ba8413962083809c. Cameras, worker admission and replay matching now use that station. Operator-enabled parked readiness permits normal queue/Home startup; verified fresh startup Home is bound to the current session/episode/lease. Subsequent commands require fresh safe settled hardware and the same lease; homed describes being at the Home pose, so moving away from Home does not revoke startup verification.
