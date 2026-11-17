# Map interaction for the TA5500 agents — design

Status: agreed with the user · 2026-11-17 · branch `optimize-agent-interaction`

Related: [2026-11-14-plan-aware-assistant-design.md](2026-11-14-plan-aware-assistant-design.md) (the base design), `masterplan5500.pdf` (repo root, gitignored).

## 1. Problem

Asked "תציג לי את גבולות התוכנית", the Map agent answered "the place is outside Tel Aviv". The model put the plan's name ("תא/5500") in `place`, it was geocoded and fell outside the planning areas. That bug is fixed (`placeTextStep` treats the plan or the city as no place). Behind it is a wider gap: the agents know only 6 plan layers by service layer id, do not know the map's 5 layer groups, cannot ask the user to choose, and "reset" does not return the map to its startup state.

## 2. Defaults

- No place named → the whole of Tel Aviv-Yafo and its neighbourhoods.
- No plan named → plan תא/5500.
- The plan or the city named as a "place" ("תא/5500", "התוכנית", "תל אביב") is no place.

## 3. Facts the design rests on

**The map's layer groups are the plan's 5 drawings (תשריטים)** — plan section 1, items (ב)–(ו): אזורי ייעוד, אזורי ומרחבי תכנון, תחבורה וניידות, עיצוב עירוני, סביבה ותשתיות. The plan ties chapters to drawings: chapter 3 ↔ אזורי ייעוד, chapter 4 ↔ עיצוב עירוני, chapter 5 ↔ אזורי ומרחבי תכנון (plan text, introduction).

**Layer inventory** (LayerList, 2026-11-17; group title, then layer titles):

| Group | Layers |
|---|---|
| אזורי ייעוד 5500 | גבול התכנית · אזור תכנון ומספרו · מוקדי תחבורה כללי · מוקדי פיתוח ושימוש עירוניים · צירי תכנון וקווי תיחום · ייעודי תעסוקה וקירוי · אזורי ייעוד תכנוניים |
| עיצוב עירוני 5500 | גבול התכנית · אזור תכנון ומספרו · מוקדי פיתוח ושימוש עירוניים · צירי תכנון וקווי תיחום · עיצוב עירוני פוליגוני · מדרגות גובה בינוי · אזורים ללא גובה |
| אזורי ומרחבי תכנון 5500 | שמות רחובות עירוניים · גבול התכנית · צירי תכנון וקווי תיחום · אזור תכנון ומספרו · מרחבי תכנון · הוראות רחוב מיוחדות |
| סביבה ותשתיות 5500 | שמות רחובות עירוניים · קווים מאזורי ייעוד · גבול התכנית · אזור תכנון ומספרו · נקודות תשתית חמשל מים וביוב · קווי תשתית · פוליגוני תשתיות עירוניות · מתקנים הנדסיים ימיים ונחלים |
| תחבורה וניידות 5500 | שמות רחובות עירוניים · גבול התכנית · מוקדי תחבורה · רשת תחבורה מטרופולינית · פוליגונים תחבורה · אזורי יעוד - דרך מהירה, ים ונחלים |

At startup some layers are visible (e.g. "צירי תכנון וקווי תיחום" in אזורי ייעוד) and the group "אזורי ומרחבי תכנון 5500" is visible.

**Plan text checks.** "תכנון בר קיימה" is section 4.5 (p. 69; the PDF's table of contents says 4.4), text only, no drawing. Area 101 (p. 80–81) has sub-areas 101א–101ז; its table rows name "אזורי תכנון" as the drawing with the boundaries.

## 4. Behaviour

**4.1 Layer catalog.** The agents read the map's layers at run time as (group title, layer title, layer). A request names a layer by its title (or the title's leading part before "ו…", e.g. "צירי תכנון", "מוקדי פיתוח"), and may name a group (e.g. "באזורי ייעוד 5500", "בתשריט התחבורה"). Spelling variants are equal: תוכנית/תכנית, איזור/אזור, יעוד/ייעוד, גבולות/גבול; "5500" and "תא/" are ignored.

**4.2 Ask when a named layer is in several groups.** If the named layer is in more than one group and no group is named, the Map agent asks which group, lists them, and leaves the map unchanged. The user's next message answers; an answer that matches none of the groups is asked again. The Plan agent never asks about layers: it uses a catalog layer only when it resolves to exactly one layer.

**4.3 Ask when a place name matches several planning areas.** A place name that matches several planning areas (or, when no area matches, several sub-areas) by name is not geocoded: both agents ask which one and list them as "אזור 102 – רמת אביב ג'". A name that matches exactly one area or sub-area is that place.

**4.4 Showing a whole layer.** A chosen catalog layer is shown whole (all features). With a place, it is clipped to the place and the map goes to the place; without one, the map goes to the layer's full extent. Like every focus, the other feature layers are hidden until reset.

**4.5 Reset = the startup state.** "אפס את המפה" / "נקה מיקוד" returns every layer's visibility and the viewpoint to what they were when TA5500 mode started for this map (after login and map load), and clears filters, effects and the outline. Layers added after startup are left as they are. The baseline is taken again when the map changes.

**4.6 The Plan agent changes the map only when the answer is about a place or a plan layer.** A text-only answer (e.g. section 4.5) leaves the map unchanged.

## 5. Scenarios (acceptance)

| # | Request | Map | Reply |
|---|---|---|---|
| 1 | תציג לי את גבולות התוכנית | unchanged | asks which of the 5 drawings; after a valid choice shows that layer and goes to its full extent |
| 2 | אילו צירי תכנון יש באיזור ייעוד 5500 באזור הצפון הישן? | "צירי תכנון וקווי תיחום" of אזורי ייעוד, clipped to area 301, map at 301 | the plan's answer |
| 3 | תאפס לי את המפה | startup visibility and viewpoint | map back to the start |
| 4 | מהן ההוראות בנושא תכנון בר קיימה | unchanged | section 4.5 |
| 5 | מהן ההוראות המיוחדות לאזור צפון מערב העיר ושדה דב | focus on area 101 with the layers of the cited sections | table 5.4 instructions for 101 |
| 6 | איך התוכנית משפיעה על כפר סבא והסביבה | unchanged | out of scope |
| 7 | מה מותר לבנות ברובע שדה דב? | focus on sub-area 101ו | building rights for 101ו |
| 8 | איפה יש אזורי מגורים בבנייה רבת קומות? | city-wide, zone type 3.2.5 highlighted, map at its extent | short answer with section |
| 9 | (after 5) ומה לגבי גובה הבנייה שם? | focus on 101 kept | heights in 101 |
| 10 | תציג לי את מוקדי הפיתוח | unchanged | asks: אזורי ייעוד or עיצוב עירוני; then as #1 |
| 11 | מה מותר לבנות ברמת אביב? | unchanged | asks which of areas 102, 103, 104, 106 |

## 6. Out of scope

Hiding catalog layers by title (hide keeps working on the 6 known layers); mapping plan chapters to drawings automatically (§3 is recorded for later); removing layers added after startup on reset.
