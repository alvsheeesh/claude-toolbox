# claude-toolbox

My portable set of Claude Code mods. One repository, one marketplace: pull it into any machine and every session gets the same tools.

| Plugin | What it does | Commands |
| --- | --- | --- |
| **prompt-upgrade** | Before a prompt runs, asks up to three quick multiple-choice questions, rewrites it, and shows the original and the upgrade side by side. Nothing runs until you press Run. | `/better <prompt>`, `/better`, `/better on`, `/better off`, `/better history` |
| **auto-model** | Sends each prompt to Haiku, Sonnet or Opus (and sets the effort) by how heavy the task is, judged by a quick Haiku call. The pick shows in the status line. | `/auto on`, `/auto off`, `/auto` |
| **clean-view** | Hides tool rows and shows a plain-English checklist of the plan above the prompt. | `/simple on`, `/simple off` |
| **burn-meter** | Session spend and the 5-hour and weekly plan limits as a band above the prompt. By [OneWave AI](https://github.com/OneWave-AI/claude-code-mods), MIT. | `/burn` |
| **superpowers** | Skill pack for a disciplined build flow: brainstorm, plan, worktree, TDD, review. By [Jesse Vincent](https://github.com/obra/superpowers), MIT. | (skills trigger on their own) |

The first three are mine and live in `mods/`. The last two are listed in the marketplace and installed from their own repositories, so they stay up to date with their authors.

## Install

Everything, from a shell:

```sh
git clone https://github.com/alvsheeesh/claude-toolbox.git ~/claude-toolbox
~/claude-toolbox/install.sh
```

Only some of it:

```sh
~/claude-toolbox/install.sh prompt-upgrade auto-model
```

Or by hand, at the prompt of a Claude Code session in a terminal:

```
/plugin marketplace add alvsheeesh/claude-toolbox
/plugin install prompt-upgrade@claude-toolbox
```

Then start a new session or run `/reload-plugins`.

## Update

```sh
claude plugin marketplace update claude-toolbox
claude plugin update prompt-upgrade@claude-toolbox   # and the others
```

## Notes

- **prompt-upgrade** and **auto-model** make small model calls (Haiku for questions and for picking the model, Sonnet for the rewrite). They count against your plan like any other use.
- **auto-model** never moves a long conversation to a lighter model (past 12 messages), because the new model would have to re-read it all without the prompt cache. It always moves up when the work gets heavier. Subagents keep their own model. `/auto off` returns control to `/model`.
- **prompt-upgrade** automatic mode is off by default. When on, start a prompt with `>` to send it as typed.
- The mods use Claude Code's function-hooks plugin API (early access, written against 2.1.299). Each has tests: `claude plugin test mods/<name>`.
