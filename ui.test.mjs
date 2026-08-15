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
const css = readFileSync(new URL("./public/style.css", import.meta.url), "utf8");
const favicon = readFileSync(new URL("./public/favicon.svg", import.meta.url), "utf8");

check("the page has a persistent screen-reader status region", index.includes('id="liveStatus"') && index.includes('aria-live="polite"'));
check("the favicon matches the wine-glass brand", index.includes('rel="icon" href="/favicon.svg"') && favicon.includes("🍷"));
check("browser tabs identify hosts and individual voters", app.includes("'Host for Wine Night'") && app.includes("`${me.name} at Wine Night`") && app.includes("syncDocumentTitle(me)"));
check("landing and join tabs keep the default title", app.includes("function syncDocumentTitle(me = null)") && app.includes(": 'Wine Night'"));
check("successful submissions are announced", app.includes("announceStatus('Ballot submitted successfully.')"));
check("the submit action shows its pending state", app.includes("Submitting ballot…") && app.includes("aria-busy"));
check("submitted ballots show a persistent confirmation", app.includes('class="ballot-confirmation"') && app.includes("ballotIsSubmitted"));
check("submitted ballots use an update action", app.includes("'Update my ballot'"));
check("the confirmation uses a high-visibility panel", css.includes(".ballot-confirmation") && css.includes("border: 2px solid"));
check("mobile header labels cannot wrap", css.includes(".topright") && css.includes("white-space: nowrap"));
check("the logo replaces the separate new-night header action", index.includes('id="homeLink" href="/"') && !index.includes('id="newNight"'));
check("leaving through the logo protects unsaved ballot work", app.includes("Your unsaved ballot changes and tasting notes will be lost"));
check("re-entering a room restores its verified saved identity", app.includes("function restoreRoomIdentity") && app.includes("snap.viewer.isHost === true"));
check("the header separates its room and current-pour pills", index.includes('id="roomBadge" class="room-badge"') && index.includes('id="pourBadge" class="pour-badge"') && app.includes("pourBadge.textContent = `Wine ${pour.wineCode}`"));
check("the current pour is the prominent header pill", css.includes(".pour-badge") && css.includes("background: var(--wine)") && css.includes(".room-badge") && css.includes("background: #f5f0ec"));
check("the glossary uses the visible decisiveness heading", app.includes("<b>How decisive was it?</b>") && !app.includes("<b>Confidence indicator</b>"));
check("participant reveal waiting text is centered as one group", app.includes('class="reveal-waiting"') && css.includes(".reveal-waiting h2") && css.includes("padding: 18px 0"));
check("the URL path is the source of truth for room startup", app.includes("const canonicalPath = `/${state.room}`") && !app.includes("if (!state.room && load('room'))"));
check("the root URL always returns to the landing page", app.includes("if (state.room) {") && app.includes("} else {\n\t\trenderLanding();"));
check("the primary ballot action appears before optional notes", app.indexOf('id="submitRatings"') < app.indexOf('class="notes-section"'));
check("note writers have a nearby secondary submission action", app.includes('data-submit-ballot="notes"') && app.includes("Update ballot and notes"));
check("print is presented as the final optional results action", app.indexOf('id="printResults"') > app.indexOf('class="card methodology-card"'));
check("host backups are grouped with bottom utility actions", app.includes('class="host-utility-actions no-print"') && app.includes('class="result-footer-actions no-print"'));
check("methodology terms link to external references", ["Ranked_voting", "Borda_count", "Condorcet_method", "Ranking_%28statistics%29", "Variance", "Spearman%27s_rank_correlation_coefficient", "Statistical_significance"].every((term) => app.includes(`wikipedia.org/wiki/${term}`)));
check("methodology terms follow the calculation flow", ["Ranking <", "Normalization <", "Borda count <", "Condorcet method <", "How decisive was it?", "Rank variance <", "Spearman correlation <"].map((term) => app.indexOf(term)).every((position, index, positions) => position >= 0 && (index === 0 || position > positions[index - 1])));
check("external glossary links preserve the results page", app.includes('class="glossary-link"') && app.includes('target="_blank" rel="noopener noreferrer"'));
check("external glossary links announce their behavior", app.includes('(opens in a new tab)'));
check("missing join names show a focused field error", app.includes("requireName(nameInput, nameError") && app.includes("setFieldError(input, errorElement, message, true)"));
check("numeric scores validate while they are entered", app.includes("input.addEventListener('input', () => validateNumericScore(input))"));
check("invalid numeric scores are identified accessibly", app.includes("input.setAttribute('aria-invalid', 'true')") && css.includes('input[aria-invalid="true"]'));
check("non-numeric score entry shows a format error", ["keydown", "beforeinput", "paste"].every((event) => app.includes(`input.addEventListener('${event}'`)) && app.includes("Enter numbers only."));
check("scientific notation is not accepted as a numeric score", app.includes("if (!/^\\d+$/.test(input.value))"));
check("numeric scores request the mobile number keypad", app.includes('inputmode="numeric"') && app.includes('enterkeyhint="${index === wines.length - 1 ? \'done\' : \'next\'}"'));
check("score placeholders lighten and disappear on focus", css.includes("input.score-input::placeholder") && css.includes("input.score-input:focus::placeholder { opacity: 0; }"));
check("tasting-note placeholders disappear on focus", css.includes(".note-input::placeholder") && css.includes(".note-input:focus::placeholder { opacity: 0; }"));
check("host ballot pills do not repeat their status in prose", !app.includes("Still waiting for") && !app.includes("Everyone has submitted a ballot"));
check("page errors are spaced and automatically revealed", app.includes("el.scrollIntoView") && css.includes(".app-error { scroll-margin-top: 84px; }"));
check("joining asks only for a name before the ballot", !app.includes('id="jNumericMax"') && !app.includes('id="vNumericMax"') && app.includes("You’ll choose how you want to vote on the next screen"));
check("the ballot owns the voting-method decision", app.includes("Choose how you want to vote") && app.includes("All three methods count equally"));
check("method guidance stays with the method picker", app.includes('id="methodDetails"') && app.includes("Put every wine in order") && app.includes("Choose only your three favorites"));
check("the numeric scale stays with its method guidance", app.includes('class="method-details numeric-method-settings"') && app.includes("Scores run from 1 to"));
check("the scoring card starts directly with ballot controls", !app.includes('class="rank-head"') && !app.includes('class="numeric-scale-row"') && !css.includes(".rank-head"));
check("method exploration preserves the submitted ballot", !app.includes("participantApi('/api/participant/clear'") && app.includes("captureBallotDraft(wines, state.mode)"));
check("numeric scores and wine order are kept as independent drafts, never derived from each other", app.includes("function draftKey(mode)") && !app.includes("orderedWineIdsFromNumeric") && !app.includes("proportionalScoresFromOrder"));
check("switching methods explains the two ballots are independent", app.includes("separate from your wine order") && app.includes("separate from your numeric scores"));
check("private notes survive voting-method previews", app.includes("state.pendingNotes = captureDraftNotes()") && app.includes("state.pendingNotes || snap.notes"));
check("method conversion does not add a visible notice", !app.includes('class="conversion-note"') && !css.includes(".conversion-note"));
check("hosts can remove an abandoned or duplicate voter from the roster", app.includes("data-remove-participant=") && app.includes("wireHostParticipantRemoval") && app.includes("'/api/host/remove-participant'"));
check("removing a voter who already submitted warns that their vote is deleted", app.includes("already submitted a ballot. Removing them deletes their vote and notes"));
check("the QR join modal fully hides the page behind it", css.includes(".overlay {") && css.includes("background: var(--ink);") && !css.includes("rgba(43, 26, 34, 0.55)"));
check("the ballot heading identifies its voter", app.includes('id="ballotOwner"') && app.includes("’s ballot"));
check("the ballot heading opens an accessible inline name editor", app.includes('id="editNameToggle"') && app.includes('aria-controls="nameEditor"') && app.includes('id="cancelNameEdit"'));
check("the inline name editor avoids a redundant visible label", app.includes('id="editName"') && app.includes('aria-label="Name on your ballot"'));
check("wine editing reuses the add form without prompts", app.includes('id="editingWineId"') && app.includes("textContent = 'Edit wine'") && app.includes("textContent = 'Save changes'") && !app.includes("prompt('Wine name'"));
check("wine editing can be cancelled without saving", app.includes('id="cancelWineEdit"') && app.includes("resetWineForm(true)"));
check("the touch drag card stays above the finger", app.includes("event.clientY - bounds.height - 18"));
check("wine insights share one consistent statistic layout", ["Most consistently placed", "The debate wines", "Best value"].every((heading) => app.includes(heading)) && (app.match(/class="wine-stat-item"/g) || []).length >= 3);
check("value appears before the adjacent variance insights", app.indexOf("${renderValue(snap, winesById)}") < app.indexOf("${renderMostConsistent(snap, winesById)}") && app.indexOf("${renderMostConsistent(snap, winesById)}") < app.indexOf("${renderDebateWines(snap, winesById)}"));
check("the debate-wine selection rule is explained", app.includes("highest-variance 20% of wines") && app.includes("at least two ballots"));
check("person statistics use restrained accessible emoji", ["🎯", "🥂", "👥"].every((emoji) => app.includes(`aria-hidden="true">${emoji}</span>`)));
check("the ballot comparison names the group clearly", app.includes("<small>The group</small>"));

console.log(`\n${pass} UI tests passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
