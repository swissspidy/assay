/** The real web apps of the evaluation (ADR 0009). */
import { gitea } from './apps/gitea.ts';
import { prestashop } from './apps/prestashop.ts';
import { wordpress } from './apps/wordpress.ts';
import type { RealApp } from './lib/types.ts';

export const APPS: RealApp[] = [gitea, wordpress, prestashop];
