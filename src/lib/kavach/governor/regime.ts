/**
 * KAVACH — regime state machine (M4.1).
 * CALM → STRESSED → CRISIS → RECOVERY on inputs: EWMA vol ratio (30d/250d),
 * portfolio drawdown, radar severity (tighten-only), margin utilization.
 * Hysteresis: 2 confirmed days to enter CRISIS, 3 to exit.
 */

import { Regime } from '../types';

export interface RegimeInputs {
  volRatio: number;
  drawdown: number;
  radarSeverity: number; // applied (tighten-only) severity, decaying max
  marginUtilization: number; // (postedMtf + postedCcil) / NAV
}

export class RegimeMachine {
  regime: Regime = 'CALM';
  radarPressure = 0; // decaying max of applied radar severities — never loosens
  private crisisConfirm = 0;
  private stressedConfirm = 0;
  private exitConfirm = 0;
  transitions: { day: number; from: Regime; to: Regime; why: string }[] = [];

  /** Durable snapshot (LIVE sessions survive restarts). */
  serialize(): { regime: Regime; radarPressure: number; crisisConfirm: number; stressedConfirm: number; exitConfirm: number } {
    return {
      regime: this.regime,
      radarPressure: this.radarPressure,
      crisisConfirm: this.crisisConfirm,
      stressedConfirm: this.stressedConfirm,
      exitConfirm: this.exitConfirm,
    };
  }

  restore(s: ReturnType<RegimeMachine['serialize']>): void {
    this.regime = s.regime;
    this.radarPressure = s.radarPressure;
    this.crisisConfirm = s.crisisConfirm;
    this.stressedConfirm = s.stressedConfirm;
    this.exitConfirm = s.exitConfirm;
  }

  /** Apply an external severity — A7: may only tighten (raise), never lower. */
  applyRadarSeverity(sev: number): void {
    if (sev > this.radarPressure) this.radarPressure = sev;
  }

  decay(): void {
    this.radarPressure *= 0.85;
  }

  update(day: number, x: RegimeInputs): Regime {
    this.decay();
    const crisisScore =
      x.volRatio > 1.9 ||
      x.drawdown < -0.09 ||
      (this.radarPressure >= 4 && x.volRatio > 1.45) ||
      x.marginUtilization > 0.035;
    const stressedScore =
      x.volRatio > 1.35 || x.drawdown < -0.04 || this.radarPressure >= 3 || x.marginUtilization > 0.02;

    switch (this.regime) {
      case 'CALM': {
        if (stressedScore || crisisScore) {
          this.regime = 'STRESSED';
          this.crisisConfirm = crisisScore ? 1 : 0;
          this.stressedConfirm = 0;
          this.exitConfirm = 0;
          this.transitions.push({
            day,
            from: 'CALM',
            to: 'STRESSED',
            why: `volRatio=${x.volRatio.toFixed(2)} dd=${(x.drawdown * 100).toFixed(1)}% radar=${this.radarPressure.toFixed(1)} marginUtil=${(x.marginUtilization * 100).toFixed(1)}%`,
          });
        }
        break;
      }
      case 'STRESSED': {
        if (crisisScore) {
          this.crisisConfirm++;
          if (this.crisisConfirm >= 2) {
            this.transitions.push({ day, from: 'STRESSED', to: 'CRISIS', why: '2 confirmed crisis days' });
            this.regime = 'CRISIS';
            this.exitConfirm = 0;
          }
        } else if (!stressedScore) {
          this.exitConfirm++;
          this.crisisConfirm = 0;
          if (this.exitConfirm >= 2) {
            this.transitions.push({ day, from: 'STRESSED', to: 'CALM', why: '2 confirmed calm days' });
            this.regime = 'CALM';
            this.exitConfirm = 0;
          }
        } else {
          this.crisisConfirm = 0;
          this.exitConfirm = 0;
        }
        break;
      }
      case 'CRISIS': {
        if (!crisisScore && !stressedScore) {
          this.exitConfirm++;
          if (this.exitConfirm >= 3) {
            this.transitions.push({ day, from: 'CRISIS', to: 'RECOVERY', why: '3 confirmed calm days' });
            this.regime = 'RECOVERY';
            this.crisisConfirm = 0;
          }
        } else {
          this.exitConfirm = 0;
        }
        break;
      }
      case 'RECOVERY': {
        if (crisisScore) {
          this.crisisConfirm++;
          if (this.crisisConfirm >= 2) {
            this.transitions.push({ day, from: 'RECOVERY', to: 'CRISIS', why: 'relapse: 2 confirmed crisis days' });
            this.regime = 'CRISIS';
            this.exitConfirm = 0;
          }
        } else if (stressedScore) {
          this.transitions.push({ day, from: 'RECOVERY', to: 'STRESSED', why: 'stress re-intensified' });
          this.regime = 'STRESSED';
          this.crisisConfirm = 0;
        } else if (x.volRatio < 1.15 && x.drawdown > -0.02) {
          this.transitions.push({ day, from: 'RECOVERY', to: 'CALM', why: 'normalized' });
          this.regime = 'CALM';
        }
        break;
      }
    }
    return this.regime;
  }
}
