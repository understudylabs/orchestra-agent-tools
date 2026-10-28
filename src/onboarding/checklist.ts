import kleur from "kleur";

type StepState = "pending" | "running" | "done" | "skipped" | "failed";

interface Step {
  id: string;
  label: string;
  state: StepState;
  /** Written above the live area for good. */
  printed: boolean;
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface ChecklistOutput {
  write(text: string): void;
  isTTY?: boolean;
}

/**
 * Every step is listed up front and ticks off in place, so a person always
 * sees what is left. Finished steps are printed once and stay put; only the
 * running and pending steps below them are redrawn. `pause` clears that live
 * part so a prompt (email, sign-in code) can use the terminal, and `resume`
 * draws it again underneath.
 *
 * Without a TTY each finished step is printed as one plain line.
 */
export class Checklist {
  private readonly steps: Step[];
  private drawn = 0;
  private frame = 0;
  private timer: NodeJS.Timeout | null = null;
  private paused = false;

  constructor(
    labels: { id: string; label: string }[],
    private readonly out: ChecklistOutput = process.stdout,
  ) {
    this.steps = labels.map((step) => ({ ...step, state: "pending", printed: false }));
  }

  start(id: string, label?: string): void {
    this.update(id, "running", label);
    if (this.out.isTTY && !this.timer) {
      this.timer = setInterval(() => {
        this.frame += 1;
        this.draw();
      }, 80);
    }
  }

  done(id: string, label?: string): void {
    this.update(id, "done", label);
  }

  skip(id: string, label?: string): void {
    this.update(id, "skipped", label);
  }

  fail(id: string, label?: string): void {
    this.update(id, "failed", label);
  }

  pause(): void {
    this.clearLive();
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.draw();
  }

  /** Stop the spinner; anything still pending stays as listed. */
  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.draw();
    this.drawn = 0;
  }

  private update(id: string, state: StepState, label?: string): void {
    const step = this.steps.find((candidate) => candidate.id === id);
    if (!step) return;
    step.state = state;
    if (label) step.label = label;
    if (!this.out.isTTY) {
      if (state !== "running") this.out.write(`${this.line(step)}\n`);
      return;
    }
    this.draw();
    if (!this.steps.some((candidate) => candidate.state === "running") && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private line(step: Step): string {
    switch (step.state) {
      case "done":
        return `  ${kleur.green("✓")} ${step.label}`;
      case "failed":
        return `  ${kleur.red("✗")} ${step.label}`;
      case "skipped":
        return `  ${kleur.gray(`– ${step.label}`)}`;
      case "running":
        return `  ${kleur.cyan(FRAMES[this.frame % FRAMES.length])} ${step.label}`;
      default:
        return `  ${kleur.gray(`○ ${step.label}`)}`;
    }
  }

  private clearLive(): void {
    if (this.out.isTTY && this.drawn > 0) {
      // Up to the first live line, then clear to the end of the screen.
      this.out.write(`\x1b[${this.drawn}F\x1b[J`);
      this.drawn = 0;
    }
  }

  private draw(): void {
    if (!this.out.isTTY || this.paused) return;
    this.clearLive();
    // Finished steps at the top of the live area are written for good.
    let firstLive = this.steps.findIndex((step) => step.state === "pending" || step.state === "running");
    if (firstLive === -1) firstLive = this.steps.length;
    for (const step of this.steps.slice(0, firstLive)) {
      if (step.printed) continue;
      this.out.write(`${this.line(step)}\n`);
      step.printed = true;
    }
    const live = this.steps.slice(firstLive);
    for (const step of live) this.out.write(`${this.line(step)}\n`);
    this.drawn = live.length;
  }
}
