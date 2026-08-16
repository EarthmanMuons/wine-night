import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;

function check(name, condition) {
  if (condition) pass++;
  else {
    fail++;
    console.error("FAIL:", name);
  }
}

const index = readFileSync(new URL("./public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("./public/app.js", import.meta.url), "utf8");
const printCss = readFileSync(new URL("./public/print.css", import.meta.url), "utf8");

check("print stylesheet is loaded only for print", index.includes('href="/print.css" media="print"'));
check("results provide a print action", app.includes('id="printResults"'));
check("print action has a recognizable icon", app.includes('class="print-icon"'));
check("print action opens the system print dialog", app.includes("onBtn(app, '#printResults', () => window.print())"));
check("print output includes the event theme", app.includes('class="print-header"'));
check("the on-screen banner's theme line is hidden in print to avoid duplicating the print header's", printCss.includes(".banner-theme"));
check("screen controls are omitted from print", printCss.includes(".no-print"));
check("private result rows avoid page breaks", printCss.includes(".ballot-comparison-row"));
check("large rank charts scale to the printed page", printCss.includes("max-width: 100% !important"));
check("print layout uses compact type", printCss.includes("font-size: 9.5pt"));

console.log(`\n${pass} print tests passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
