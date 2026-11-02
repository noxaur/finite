// Finite without its search tools, as before find_nodes and replace_values
// shipped. Comparing a round on this with a round on the real server checks
// the mock against the first study in e2e/ax/README.md: rebrand took 11.3
// calls without search and 5.7 with it.
export default {
  instructions: (real) =>
    real
      .replace(/\n\nSearch: [^\n]*/, "")
      .replace(
        "for part of a <style> or <script>, use replace_values with within, and set_text_content only to rewrite all of it.",
        "to change a <style> or <script>, set_text_content on it with the whole new CSS.",
      ),
  drop: ["find_nodes", "replace_values"],
};
