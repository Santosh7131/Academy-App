/// How many options a question can have, and the letters the apps give them. Four is the fewest and six the most: a paper can print
/// five (an Assertion and Reason key of (a) to (e)) or six. The server holds the same limits (api/src/lib/options.ts), and an app from
/// before build 13 is never sent a question with more than four.
const minOptions = 4;
const maxOptions = 6;
const _optionLetters = 'ABCDEF';

/// The letter of option [i] (0 is A). Past F it is the number, so a surprise shows as a strange label and not as a crash.
String optionLetter(int i) => i >= 0 && i < _optionLetters.length ? _optionLetters[i] : '${i + 1}';

/// "four", "five" or "six", for a sentence such as "Fill in all five options."
String optionCountWord(int n) => const {4: 'four', 5: 'five', 6: 'six'}[n] ?? '$n';
