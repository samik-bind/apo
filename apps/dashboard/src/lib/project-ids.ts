/**
 * Project id constants shared by server and client components.
 *
 * Keep this module free of framework directives: server components must
 * compare against the plain string — importing a constant from a
 * ``"use client"`` module yields a client-module proxy on the server, and
 * every ``===`` comparison silently evaluates false.
 */
export const DEFAULT_PROJECT = "example-service";
export const DEMO_PROJECT = "demo";
