@echo off
rem 全屏一次性提醒光圈 — 任意 shell 一行调用入口
rem 例: ring.cmd -Seconds 4 -Scope Primary -Anim Expand
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0Show-AttnRing.ps1" %*
