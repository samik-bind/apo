import { redirect } from "next/navigation";

/** Shareable demo alias (SPEC-188 U1): /demo → the demo tasks page. */
export default function DemoAliasPage() {
  redirect("/project/demo/tasks");
}
