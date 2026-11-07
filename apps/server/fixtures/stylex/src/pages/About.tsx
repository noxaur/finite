import * as stylex from "@stylexjs/stylex";
import { text } from "../styles/text.ts";

export default function About() {
  return <h1 {...stylex.props(text.title)}>About us</h1>;
}
