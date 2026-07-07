# CORE-1169 judge-override audit (from committed fixtures)

Lexical-harder items: 72/960. After the judge override the combined gate flags 21/960 as harder.

- **Harder overrides** (lexical said harder, judge cleared): **65**
- **Judge-added harder catches** (lexical missed, judge caught): **14**
- **Jargon overrides** (lexical jargon, judge cleared): **41**

Override rule: fires only when `0 < delta < 0.5` AND `judge score >= 4`.

## Honesty check: PASS — every one of the 65 harder overrides is borderline (delta < 0.5) with a confident-plain judge (score >= 4). No genuinely-harder item was silenced.

## All harder overrides (the 8th-grade call the green rests on)

- **archaic / arch-09|socratic|brief|anthropic** (tier brief, model anthropic)  
  lexical delta `+0.453` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: As good almost kill a man as kill a good book: who kills a man kills a reasonable creature, but he who destroys a good book kills reason itself.  
  ANSWER: According to Milton, why is destroying a good book actually *worse* than killing a single person?  
  JUDGE REASON: The question is straightforward, uses plain language, no jargon, and is understandable without a dictionary.
- **archaic / arch-07|historical|brief|anthropic** (tier brief, model anthropic)  
  lexical delta `+0.313` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: What song the Sirens sang, or what name Achilles assumed when he hid himself among women, though puzzling questions, are not beyond all conjecture.  
  ANSWER: Browne is referring to two famous ancient riddles: the Sirens were mythical creatures in Greek stories whose irresistible song lured sailors to their deaths, and Achilles was a great warrior who once disguised himself as a girl to avoid going to war.  
  JUDGE REASON: The answer uses simple, everyday language and explains the riddles clearly.
- **archaic / arch-09|vocabulary|deep|anthropic** (tier deep, model anthropic)  
  lexical delta `+0.205` | judge score `4` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: As good almost kill a man as kill a good book: who kills a man kills a reasonable creature, but he who destroys a good book kills reason itself.  
  ANSWER: **reasonable creature**: Today "reasonable" just means calm or sensible. Milton means something bigger: a being that *has reason*, meaning the God-given power to think, judge, and understand truth. That was the standard way to define a human being in his time. So when he says killing a man destroys "a reasonable creature," he means you have ended one person's thinking mind. But a good book, he say  
  JUDGE REASON: The answer explains the passage in everyday language, using simpler words and clear examples. It avoids heavy jargon and can be understood without a dictionary. The only slightly more complex phrase is "God‑given power," but overall the text remains plain. No further explanation is needed.
- **archaic / arch-09|historical|deep|anthropic** (tier deep, model anthropic)  
  lexical delta `+0.195` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: As good almost kill a man as kill a good book: who kills a man kills a reasonable creature, but he who destroys a good book kills reason itself.  
  ANSWER: Milton wrote this in 1644 to fight a law that made printers get government approval before publishing anything. The people running England at the time could simply block any book they disliked. Milton thought that was as bad as murder, which is why he says "kills reason itself." A person who dies still leaves their ideas behind in others, but a book that never gets printed takes its ideas with it   
  JUDGE REASON: The tutor’s answer uses modern, everyday language, avoids archaic or academic terms, and explains the source in a way that a reader who found the original passage difficult would understand without needing a dictionary. It is straightforward, free of jargon, and does not require further explanation.
- **archaic / arch-01|vocabulary|brief|anthropic** (tier brief, model anthropic)  
  lexical delta `+0.191` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: As I walked through the wilderness of this world, I lighted on a certain place where was a den, and laid me down in that place to sleep; and as I slept, I dreamed a dream.  
  ANSWER: **lighted on**: happened to come across; stumbled upon a place  
  JUDGE REASON: The answer explains the archaic phrase in simple, everyday language, making it understandable without a dictionary.
- **archaic / arch-09|socratic|deep|local** (tier deep, model local)  
  lexical delta `+0.190` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: As good almost kill a man as kill a good book: who kills a man kills a reasonable creature, but he who destroys a good book kills reason itself.  
  ANSWER: 1. The author says killing a good book is almost as bad as killing a person. Why does he think destroying a book hurts "reason itself" more than hurting a human body?
2. If a book holds the ideas that help us think clearly, what happens to our ability to solve problems when we throw away all the books we disagree with?
3. Does this mean we should never ban any book, even ones that seem wrong to us  
  JUDGE REASON: The tutor’s questions use everyday language, simpler vocabulary, and no academic jargon, making them easier to understand than the archaic source passage. They do not require further explanation.
- **archaic / arch-01|socratic|deep|anthropic** (tier deep, model anthropic)  
  lexical delta `+0.167` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: As I walked through the wilderness of this world, I lighted on a certain place where was a den, and laid me down in that place to sleep; and as I slept, I dreamed a dream.  
  ANSWER: 1. The writer says he fell asleep in a den and had a dream. So is the story we are about to read meant to be taken as something that really happened, or as something he saw only in his mind while sleeping?

2. If the whole story comes from a dream, why do you think the writer bothers to tell us exactly where he was when he fell asleep?

3. What does it say about a person's inner life that the deep  
  JUDGE REASON: The answer uses plain modern language, avoids jargon, and is easily understood even by someone who found the archaic source difficult.
- **archaic / arch-09|historical|deep|local** (tier deep, model local)  
  lexical delta `+0.131` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: As good almost kill a man as kill a good book: who kills a man kills a reasonable creature, but he who destroys a good book kills reason itself.  
  ANSWER: Milton compares killing a person to destroying a good book, saying both acts are almost as bad. He argues that while a person is a reasonable creature, a book holds reason itself. If you burn a book, you are not just losing paper and ink; you are killing the very ability to think clearly. This mattered because people in his time often burned books they did not like, thinking they were protecting s  
  JUDGE REASON: The answer uses modern, everyday language that a reader who struggled with the archaic source would understand. It replaces or explains the source’s terms with simpler words, avoids academic jargon, and is self‑explanatory.
- **archaic / arch-09|explain|deep|local** (tier deep, model local)  
  lexical delta `+0.128` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: As good almost kill a man as kill a good book: who kills a man kills a reasonable creature, but he who destroys a good book kills reason itself.  
  ANSWER: Killing a person hurts one living human, but destroying a great book hurts the very idea of thinking clearly. Milton thinks books are like people because they hold our best ideas and help us learn. If you burn a book, you do not just lose paper; you kill the smart thoughts inside it forever. This is worse than killing a person because a dead person cannot teach us again, but a dead book stops all   
  JUDGE REASON: The answer uses everyday language, avoids archaic or technical terms, and is understandable without a dictionary. It is simpler than the source and does not require further explanation.
- **archaic / arch-09|explain|brief|anthropic** (tier brief, model anthropic)  
  lexical delta `+0.077` | judge score `4` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: As good almost kill a man as kill a good book: who kills a man kills a reasonable creature, but he who destroys a good book kills reason itself.  
  ANSWER: Killing a good book is almost as bad as killing a person, because a person only carries reason inside them, but a book *is* reason made permanent. The hidden punch here is that **destroying a book** is actually worse than murder, since a person's ideas die with them, but a book can keep spreading those ideas to everyone who reads it.  
  JUDGE REASON: The answer uses everyday language, avoids archaic or technical terms, and explains the idea clearly, making it accessible to readers who struggled with the source.
- **archaic / arch-01|explain|brief|local** (tier brief, model local)  
  lexical delta `+0.075` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: As I walked through the wilderness of this world, I lighted on a certain place where was a den, and laid me down in that place to sleep; and as I slept, I dreamed a dream.  
  ANSWER: The narrator says he traveled through a hard place called the wilderness and found a hole to sleep in before falling asleep and dreaming. The word **den** just means a small cave or hiding spot where animals live, which shows how small and safe his resting place was. This simple story starts by telling us that the main events of the book happen inside a dream while he rests.  
  JUDGE REASON: The tutor’s answer uses everyday, simple words, avoids archaic or academic terms, and conveys the meaning directly, so a reader who struggles with the source can understand it without extra help.
- **archaic / arch-09|historical|brief|local** (tier brief, model local)  
  lexical delta `+0.062` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: As good almost kill a man as kill a good book: who kills a man kills a reasonable creature, but he who destroys a good book kills reason itself.  
  ANSWER: Milton compares killing a person to destroying a book, saying that while a man is a living thinker, a book holds the very idea of thinking itself. He believes that burning a good book is just as bad as murder because it kills the power to use reason.  
  JUDGE REASON: Uses modern, everyday language and avoids jargon, making it easier to understand than the source.
- **archaic / arch-01|historical|brief|anthropic** (tier brief, model anthropic)  
  lexical delta `+0.027` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: As I walked through the wilderness of this world, I lighted on a certain place where was a den, and laid me down in that place to sleep; and as I slept, I dreamed a dream.  
  ANSWER: No special context is needed here. Bunyan is simply saying he fell asleep in a dark, lonely place and had a dream, and the whole story you are about to read is that dream.  
  JUDGE REASON: Uses modern, simple language and explains the passage clearly.
- **archaic / arch-07|explain|brief|anthropic** (tier brief, model anthropic)  
  lexical delta `+0.024` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: What song the Sirens sang, or what name Achilles assumed when he hid himself among women, though puzzling questions, are not beyond all conjecture.  
  ANSWER: Two old riddles from Greek myths get name-dropped here: the Sirens were magical creatures whose singing lured sailors to their deaths, and Achilles once disguised himself as a girl to hide from a war. Browne's **real point** is a sly one: even mysteries that seem totally unsolvable can still be guessed at with careful thinking.  
  JUDGE REASON: The answer uses everyday words, explains the source plainly, and contains no jargon, so it is easily understood without extra explanation.
- **archaic / arch-01|historical|deep|anthropic** (tier deep, model anthropic)  
  lexical delta `+0.002` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: As I walked through the wilderness of this world, I lighted on a certain place where was a den, and laid me down in that place to sleep; and as I slept, I dreamed a dream.  
  ANSWER: Bunyan wrote this book while he was locked in jail for preaching without the government's permission. The "wilderness of this world" tells you right away that he saw ordinary life as a hard, dangerous journey, not a comfortable home. The "den" where he falls asleep is almost certainly the jail cell itself. So when he says he dreamed a dream, he is doing something clever: he turns his prison into t  
  JUDGE REASON: Answer uses everyday language, no jargon, and is understandable to a reader who found the source hard.
- **irony / iron-04|socratic|brief|anthropic** (tier brief, model anthropic)  
  lexical delta `+0.310` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: October. This is one of the peculiarly dangerous months to speculate in stocks. The others are July, January, September, April, November, May, March, June, December, August, and February.  
  ANSWER: What months does the passage leave out when it lists the "other" dangerous months for buying stocks?  
  JUDGE REASON: The question is straightforward, uses everyday words, and does not require extra explanation.
- **irony / iron-04|socratic|brief|local** (tier brief, model local)  
  lexical delta `+0.193` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: October. This is one of the peculiarly dangerous months to speculate in stocks. The others are July, January, September, April, November, May, March, June, December, August, and February.  
  ANSWER: Why does the author list every month as dangerous for stock trading when only October is usually known to be risky?  
  JUDGE REASON: The question is phrased in plain, everyday language that a reader could understand without a dictionary. It uses simpler or equivalent terms compared to the source, avoids jargon, and does not require further explanation. Therefore it meets all criteria for maximum plainness.
- **irony / iron-10|vocabulary|brief|anthropic** (tier brief, model anthropic)  
  lexical delta `+0.181` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: I cannot but conclude the bulk of your natives to be the most pernicious race of little odious vermin that nature ever suffered to crawl upon the surface of the earth.  
  ANSWER: **pernicious**: harmful and destructive in the worst possible way
**odious**: deeply disgusting, worthy of hatred
**vermin**: pests, like rats or insects, treated as worthless and vile  
  JUDGE REASON: Answerable without a dictionary; uses simpler words; free of jargon; no explanation needed.
- **irony / iron-02|explain|brief|local** (tier brief, model local)  
  lexical delta `+0.179` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.  
  ANSWER: This line jokes that everyone assumes a rich single man needs a wife, but it really means the opposite: society thinks a wealthy man wants a wife, while the truth is that women are actually looking for him. The phrase **universally acknowledged** sounds like a serious fact, but it is just a funny exaggeration of how greedy people are for money.  
  JUDGE REASON: The answer uses everyday words, avoids jargon, and explains the passage in a straightforward way that a reader who found the source hard would understand without a dictionary.
- **irony / iron-04|explain|brief|anthropic** (tier brief, model anthropic)  
  lexical delta `+0.178` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: October. This is one of the peculiarly dangerous months to speculate in stocks. The others are July, January, September, April, November, May, March, June, December, August, and February.  
  ANSWER: Every month of the year is listed as dangerous for buying stocks, which means the real point is that **no month is safe**. The joke works because it starts out sounding like serious advice, then quietly lists all twelve months, making the "warning" completely useless.  
  JUDGE REASON: Answer uses simple language, no jargon, clear and understandable.
- **irony / iron-02|vocabulary|brief|anthropic** (tier brief, model anthropic)  
  lexical delta `+0.157` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.  
  ANSWER: **universally acknowledged**: everyone agrees, no exceptions, no argument allowed.
**in want of**: needing, lacking something he does not yet have.

The sentence also says the opposite of what it means: it pretends this is a fact everyone agrees on, but really it is poking fun at people who assume every rich single man must be hunting for a wife.  
  JUDGE REASON: The tutor’s answer uses everyday words, explains the phrases plainly, avoids jargon, and is clear enough that a reader who struggled with the original line would understand it without a dictionary.
- **irony / iron-01|vocabulary|deep|anthropic** (tier deep, model anthropic)  
  lexical delta `+0.148` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: I have been assured that a young healthy child well nursed is at a year old a most delicious, nourishing, and wholesome food, whether stewed, roasted, baked, or boiled.  
  ANSWER: **nursed** and **wholesome** are doing the heaviest work here.

"Well nursed" in Swift's time meant a baby that had been carefully breastfed and raised to be plump and healthy. Today "nursed" can just mean looked after when sick. Swift picks the older meaning on purpose, because it makes the baby sound like a farm animal being fattened up for slaughter, the way you would say a calf was "well fed."  
  JUDGE REASON: The answer explains the archaic words in plain language, using everyday terms, no jargon, and is understandable without a dictionary.
- **irony / iron-02|historical|deep|anthropic** (tier deep, model anthropic)  
  lexical delta `+0.133` | judge score `5` q3(no-register)=`True` | jargon lemmas: ['unmarry']  
  SOURCE: It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.  
  ANSWER: In Austen's England, a wealthy unmarried man was seen as a prize to be won, and every mother with daughters to marry off would start scheming the moment such a man moved nearby. That is exactly the world this opening line drops you into.

The joke is that the line pretends to state a great, obvious truth that "everyone" agrees on, but it is actually just what hopeful mothers and matchmaking neighb  
  JUDGE REASON: The tutor’s answer uses everyday language, avoids archaic or academic terms, and explains the source in a way that a reader who struggled with the original line would understand without a dictionary. It is straightforward and self‑contained, so it scores highly on plainness.
- **irony / iron-02|explain|brief|anthropic** (tier brief, model anthropic)  
  lexical delta `+0.116` | judge score `5` q3(no-register)=`True` | jargon lemmas: ['unmarry']  
  SOURCE: It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.  
  ANSWER: Everyone "knows" that a rich unmarried man must be desperately looking for a wife, but Austen doesn't actually believe this. The **joke** is that it's really the other way around: the families with unmarried daughters are the ones desperate to find him, not the other way around. The sentence pretends to state an obvious fact while quietly laughing at the people who think it.  
  JUDGE REASON: The answer uses everyday language, no jargon, and is easy to understand.
- **irony / iron-04|explain|brief|local** (tier brief, model local)  
  lexical delta `+0.095` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: October. This is one of the peculiarly dangerous months to speculate in stocks. The others are July, January, September, April, November, May, March, June, December, August, and February.  
  ANSWER: This joke lists every month of the year as dangerous for stock trading, but October is the only one that actually is. The writer makes a funny mistake by pretending the other eleven months are risky too, when they are just normal times. This trick shows how the speaker is being silly and not telling the truth.  
  JUDGE REASON: The answer uses everyday words, simpler than the source, no jargon, and is clear enough to be understood without extra explanation.
- **irony / iron-04|socratic|deep|local** (tier deep, model local)  
  lexical delta `+0.072` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: October. This is one of the peculiarly dangerous months to speculate in stocks. The others are July, January, September, April, November, May, March, June, December, August, and February.  
  ANSWER: 1. Why does the book say October is a dangerous month for buying stocks, but then list every other month right after it?
2. If all the months are listed, why does the author call October special when the list shows they are all just regular months?
3. Is the author trying to trick us into thinking October is bad, or is he making a joke about how people always worry about the wrong things?  
  JUDGE REASON: The answer uses plain language, avoids jargon, and is understandable without a dictionary.
- **irony / iron-04|historical|brief|local** (tier brief, model local)  
  lexical delta `+0.060` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: October. This is one of the peculiarly dangerous months to speculate in stocks. The others are July, January, September, April, November, May, March, June, December, August, and February.  
  ANSWER: This list shows that the writer thinks every single month is risky for trading stocks, which is a strange idea because usually only October is known to be dangerous. The writer is making a joke by listing all twelve months as if they are all equally bad times to gamble on the stock market.  
  JUDGE REASON: Answer uses simple, everyday words, avoids jargon, and is clear enough that no extra explanation is needed.
- **irony / iron-04|explain|deep|anthropic** (tier deep, model anthropic)  
  lexical delta `+0.059` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: October. This is one of the peculiarly dangerous months to speculate in stocks. The others are July, January, September, April, November, May, March, June, December, August, and February.  
  ANSWER: The joke is that Twain starts as if he is about to give you real, useful advice: "October is especially dangerous for playing the stock market." You lean in, ready for the exception. Then he lists every single other month as dangerous too. There are no safe months. The "warning" about October means nothing, because the warning covers all twelve months.

**The real point is that the stock market is  
  JUDGE REASON: The answer uses everyday language, avoids jargon, and explains the joke in a straightforward way that a reader who found the source hard would understand without a dictionary.
- **irony / iron-01|explain|deep|anthropic** (tier deep, model anthropic)  
  lexical delta `+0.058` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: I have been assured that a young healthy child well nursed is at a year old a most delicious, nourishing, and wholesome food, whether stewed, roasted, baked, or boiled.  
  ANSWER: Swift is not actually suggesting people eat babies. He is pretending to be a calm, reasonable expert who has done his homework, and he uses that fake calm to make a point about how the English treated poor Irish people. The shocking part is that he describes a child the same way you would describe a chicken or a pot roast, listing cooking methods like it is a recipe. **That gap between the horror   
  JUDGE REASON: The tutor’s answer uses everyday, modern language that is simpler than the archaic source, avoids academic jargon, and is clear enough that a reader could understand it without extra explanation.
- **irony / iron-10|explain|brief|anthropic** (tier brief, model anthropic)  
  lexical delta `+0.055` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: I cannot but conclude the bulk of your natives to be the most pernicious race of little odious vermin that nature ever suffered to crawl upon the surface of the earth.  
  ANSWER: The King of Brobdingnag has just heard Gulliver brag about England, and this is his verdict: humans are tiny, disgusting pests, no better than bugs. The **sting** is that "pernicious" means deeply harmful, so he is not just calling them ugly but dangerous, and the word "suffered" here means "allowed," as in nature made a mistake by letting them exist at all.  
  JUDGE REASON: The answer explains the hard words in plain language, uses simpler vocabulary, avoids jargon, and is self‑explanatory.
- **irony / iron-03|socratic|brief|anthropic** (tier brief, model anthropic)  
  lexical delta `+0.031` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: He was the mildest mannered man that ever scuttled ship or cut a throat, with such true breeding of a gentleman, you never could divine his real thought.  
  ANSWER: When Byron calls this violent man "mildest mannered" and a true gentleman, what does that surprising gap between his polite appearance and his brutal actions tell you about what Byron really thinks of him?  
  JUDGE REASON: The answer uses everyday words, avoids archaic or technical terms, and is clear enough for a reader who struggled with the source.
- **philosophy / phil-07|vocabulary|brief|local** (tier brief, model local)  
  lexical delta `+0.197` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: The life of man is solitary, poor, nasty, brutish, and short, in that condition which is called war, and such a war as is of every man against every man.  
  ANSWER: **solitary**: alone with no friends or family around
**brutish**: acting like a wild animal, cruel and violent
**condition**: the situation or state of things happening  
  JUDGE REASON: Definitions are simple, clear, and use everyday language, so the answer is easily understandable without extra explanation.
- **philosophy / phil-06|socratic|deep|local** (tier deep, model local)  
  lexical delta `+0.157` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: Man is a rope, tied between beast and overman, a rope over an abyss. What is great in man is that he is a bridge and not an end.  
  ANSWER: 1. What does it mean to say a person is just a rope hanging over a deep drop?
2. If we are a rope, why is it important to be a bridge instead of a final destination?
3. Does this mean we should keep moving toward something better, or is it okay to stop being a bridge?  
  JUDGE REASON: The answer uses everyday language, avoids jargon, and is understandable without a dictionary.
- **philosophy / phil-06|explain|brief|anthropic** (tier brief, model anthropic)  
  lexical delta `+0.149` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: Man is a rope, tied between beast and overman, a rope over an abyss. What is great in man is that he is a bridge and not an end.  
  ANSWER: Humans are not the finished product of creation but a stepping stone between animals and something greater. The tricky part is that "**overman**" means a future, higher kind of human being that Nietzsche imagined, not a superhero, and calling a person a "rope over an abyss" means we are stretched dangerously between two worlds, with nothing solid beneath us.  
  JUDGE REASON: The answer clarifies the metaphorical terms in the source, using everyday language and simple explanations. It avoids jargon, explains 'overman' and the rope metaphor, and is understandable without a dictionary. The vocabulary is simpler than the source, and the answer itself does not require further explanation.
- **philosophy / phil-05|socratic|brief|anthropic** (tier brief, model anthropic)  
  lexical delta `+0.081` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: Reason is, and ought only to be the slave of the passions, and can never pretend to any other office than to serve and obey them.  
  ANSWER: When Hume says reason should "serve and obey" the passions, what job is he saying reason actually does for our feelings, according to this sentence?  
  JUDGE REASON: The question uses everyday words, no jargon, and is clear enough for a reader of the source.
- **philosophy / phil-05|explain|brief|local** (tier brief, model local)  
  lexical delta `+0.054` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: Reason is, and ought only to be the slave of the passions, and can never pretend to any other office than to serve and obey them.  
  ANSWER: Reason is just a helper that must listen to our feelings and never try to lead us. It can only serve our desires, like a loyal slave obeying a master, because our emotions are the real bosses of our actions.  
  JUDGE REASON: The answer uses everyday words, avoids jargon, and is easier to grasp than the source.
- **philosophy / phil-04|historical|brief|anthropic** (tier brief, model anthropic)  
  lexical delta `+0.047` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: The only freedom which deserves the name is that of pursuing our own good in our own way, so long as we do not attempt to deprive others of theirs.  
  ANSWER: No special context is needed here. Mill is saying that real freedom means doing what you think is good for yourself, as long as you don't stop other people from doing the same for themselves.  
  JUDGE REASON: The answer uses everyday language, avoids jargon, and is clear enough for a reader who struggled with the source.
- **technical / tech-08|explain|brief|anthropic** (tier brief, model anthropic)  
  lexical delta `+0.364` | judge score `5` q3(no-register)=`True` | jargon lemmas: ['unimaginably']  
  SOURCE: The present is the key to the past; the same agents which are now at work in modifying the earth's crust have been operating with like energy from time immemorial.  
  ANSWER: The forces reshaping the Earth today, like rivers, volcanoes, and erosion, have been doing the exact same job for an unimaginably long time. The tricky part is "**the present is the key to the past**," which sounds like a riddle but simply means: watch what nature does right now, and you can figure out how ancient rocks and landscapes were formed.  
  JUDGE REASON: The answer replaces technical terms with everyday language, explains the key phrase, and avoids jargon, making it easier to understand than the source.
- **victorian / vict-03|historical|deep|anthropic** (tier deep, model anthropic)  
  lexical delta `+0.469` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: The greatest thing a human soul ever does in this world is to see something, and tell what it saw in a plain way; for hundreds can talk for one who can think, but thousands can think for one who can see.  
  ANSWER: Ruskin wrote "Modern Painters" to defend the painter J. M. W. Turner, whose work many critics called messy and wrong. Those critics thought good art meant following old rules and copying what earlier masters had done. Ruskin said no: the best thing an artist can do is really look at the world and then show others what they actually saw.

That is what "to see something, and tell what it saw in a pl  
  JUDGE REASON: Answer uses simple everyday language, avoids jargon, explains source clearly, so reader can understand without dictionary.
- **victorian / vict-03|historical|deep|local** (tier deep, model local)  
  lexical delta `+0.440` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: The greatest thing a human soul ever does in this world is to see something, and tell what it saw in a plain way; for hundreds can talk for one who can think, but thousands can think for one who can see.  
  ANSWER: John Ruskin believes the most important job a person can do is to look at something and describe it simply. He thinks seeing clearly is rare because many people can talk about ideas, but only a few can actually see the truth. When someone truly sees, they help thousands of other people understand what they are looking at. This matters because it stops us from just guessing or arguing about things   
  JUDGE REASON: The answer uses everyday language, avoids jargon, and explains the idea in a straightforward way that a reader who found the source challenging would understand without a dictionary. It simplifies the source’s concepts and stays clear, so it does not need further explanation.
- **victorian / vict-08|historical|brief|anthropic** (tier brief, model anthropic)  
  lexical delta `+0.425` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: Therefore, when we build, let us think that we build for ever; let it not be for present delight nor for present use alone; let it be such work as our descendants will thank us for.  
  ANSWER: No special context is needed here. Ruskin is simply saying that when we put up a building, we should make it so well and so carefully that the people who come after us will be glad we did.  
  JUDGE REASON: The answer uses everyday language, avoids jargon, and explains the source in plain terms.
- **victorian / vict-03|explain|deep|local** (tier deep, model local)  
  lexical delta `+0.414` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: The greatest thing a human soul ever does in this world is to see something, and tell what it saw in a plain way; for hundreds can talk for one who can think, but thousands can think for one who can see.  
  ANSWER: John Ruskin thinks the most important job a person can do is to look at something carefully and then explain it simply to others. He believes that while many people can think hard ideas, only a few people can actually see the world clearly. If one person can really see something, they can help hundreds of other people understand it too. Imagine if only one student in a class notices a beautiful pa  
  JUDGE REASON: Answer uses everyday language, no jargon, and is understandable without a dictionary.
- **victorian / vict-04|explain|brief|anthropic** (tier brief, model anthropic)  
  lexical delta `+0.375` | judge score `4` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: Under all speech that is good for anything there lies a silence that is better; silence is deep as eternity, speech is shallow as time.  
  ANSWER: Real meaning worth saying goes deeper than any words can reach, the way eternity is deeper than a single moment in time. The **hidden comparison** here is that time is small and temporary, while eternity is vast and endless, so speech belongs to the small world and silence belongs to the vast one.  
  JUDGE REASON: The answer uses everyday language that a reader who found the poetic source challenging would understand without a dictionary. It replaces the source’s metaphoric phrasing with simpler, more literal words such as "real meaning," "deeper," "small," and "vast." It avoids academic or literary jargon; the only slightly technical phrase, "hidden comparison," is still plain enough. The answer is self‑co
- **victorian / vict-11|explain|deep|anthropic** (tier deep, model anthropic)  
  lexical delta `+0.375` | judge score `5` q3(no-register)=`True` | jargon lemmas: ['churchgoing']  
  SOURCE: The pursuit of perfection, then, is the pursuit of sweetness and light. He who works for sweetness and light united, works to make reason and the will of God prevail.  
  ANSWER: Arnold is saying that chasing perfection means chasing two things at once: beauty ("sweetness") and clear understanding ("light"). And here is the deeper point he is making: those two things are not separate from doing what is right or good. **When you work to make the world more beautiful and more clear-thinking, you are doing God's work**, not just pleasing yourself. He is not talking about reli  
  JUDGE REASON: The tutor’s answer uses everyday words, avoids academic or literary jargon, and explains the source in plain language that a reader who struggled with the original would grasp without a dictionary.
- **victorian / vict-05|vocabulary|brief|anthropic** (tier brief, model anthropic)  
  lexical delta `+0.371` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: The happiest women, like the happiest nations, have no history; and the years that bring the philosophic mind are years that take away the keenness of joy.  
  ANSWER: **philosophic mind**: a calm, thoughtful mind that questions everything instead of just feeling it
**keenness of joy**: the sharp, intense edge of happiness, how strongly you feel it  
  JUDGE REASON: The answer gives clear, everyday definitions that are easier to understand than the source, with no jargon and no need for further explanation.
- **victorian / vict-04|historical|brief|anthropic** (tier brief, model anthropic)  
  lexical delta `+0.331` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: Under all speech that is good for anything there lies a silence that is better; silence is deep as eternity, speech is shallow as time.  
  ANSWER: No special context is needed here. Carlyle is simply saying that the deepest truths cannot be put into words, so staying silent gets closer to them than any speech can, the way eternity (time without end) is deeper and vaster than our short human lives.  
  JUDGE REASON: The answer uses everyday language, avoids jargon, and explains the idea in a way that a reader who found the poetic source difficult would understand without extra help.
- **victorian / vict-03|vocabulary|deep|local** (tier deep, model local)  
  lexical delta `+0.326` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: The greatest thing a human soul ever does in this world is to see something, and tell what it saw in a plain way; for hundreds can talk for one who can think, but thousands can think for one who can see.  
  ANSWER: The biggest job a person can do is to look at something and say exactly what they saw without making it hard to understand. Ruskin thinks seeing is rare because most people just let their minds wander while looking. They do not really watch. But if one person truly sees, they can help hundreds of others who cannot think clearly on their own. The word "plain" here means simple and clear, not boring  
  JUDGE REASON: The answer uses everyday words, explains the source’s meaning, avoids jargon, and is clear enough for a reader who struggled with the original passage.
- **victorian / vict-03|socratic|deep|anthropic** (tier deep, model anthropic)  
  lexical delta `+0.315` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: The greatest thing a human soul ever does in this world is to see something, and tell what it saw in a plain way; for hundreds can talk for one who can think, but thousands can think for one who can see.  
  ANSWER: 1. Ruskin says seeing is rarer than thinking, and thinking is rarer than talking. So what does he mean by "seeing" here, since everyone with eyes can see?

2. If real seeing is that rare, what would stop most people from doing it, even when they are looking straight at something?

3. Could this idea reach beyond art and painting, into any part of life where most people miss what is right in front   
  JUDGE REASON: The answer uses everyday language, avoids jargon, and is easier to understand than the poetic source.
- **victorian / vict-03|socratic|brief|local** (tier brief, model local)  
  lexical delta `+0.253` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: The greatest thing a human soul ever does in this world is to see something, and tell what it saw in a plain way; for hundreds can talk for one who can think, but thousands can think for one who can see.  
  ANSWER: Why does Ruskin say that one person who can truly see and speak plainly is worth many people who only talk?  
  JUDGE REASON: The question is phrased in everyday language, uses simpler words than the source, contains no jargon, and does not require further explanation.
- **victorian / vict-02|vocabulary|deep|anthropic** (tier deep, model anthropic)  
  lexical delta `+0.220` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: If we had a keen vision and feeling of all ordinary human life, it would be like hearing the grass grow and the squirrel's heart beat, and we should die of that roar which lies on the other side of silence.  
  ANSWER: **"the other side of silence"** and **"keen vision and feeling"** both need unpacking here.

"Keen vision and feeling" means being able to notice and truly feel everything happening around you, every tiny thing, all at once. Today "keen" just means sharp or eager, but Eliot means something stronger: a kind of perfect, total awareness, like having every sense turned up as high as it can go.

The st  
  JUDGE REASON: The answer explains the difficult terms in plain language, uses simpler words, avoids jargon, and is self‑explanatory.
- **victorian / vict-05|vocabulary|brief|local** (tier brief, model local)  
  lexical delta `+0.190` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: The happiest women, like the happiest nations, have no history; and the years that bring the philosophic mind are years that take away the keenness of joy.  
  ANSWER: **philosophic**: thinking deeply about big ideas like life and truth
**keenness**: sharp feeling or excitement
**history**: a long list of past events that change a person or place  
  JUDGE REASON: Q1: The definitions use plain language, so a reader can understand without a dictionary.; Q2: The answer uses everyday words, simpler than the source.; Q3: No academic jargon is present.; Q4: The definitions are clear and need no further explanation.
- **victorian / vict-08|vocabulary|brief|anthropic** (tier brief, model anthropic)  
  lexical delta `+0.176` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: Therefore, when we build, let us think that we build for ever; let it not be for present delight nor for present use alone; let it be such work as our descendants will thank us for.  
  ANSWER: **descendants**: your children, grandchildren, and all future family after you  
  JUDGE REASON: The answer is a plain definition that uses everyday words and is easy to understand.
- **victorian / vict-03|historical|brief|local** (tier brief, model local)  
  lexical delta `+0.155` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: The greatest thing a human soul ever does in this world is to see something, and tell what it saw in a plain way; for hundreds can talk for one who can think, but thousands can think for one who can see.  
  ANSWER: Ruskin believes that seeing clearly is the most important job because one person who actually looks at something can help hundreds of people who just talk about it. He thinks that being able to see and describe what you see is better than just having ideas in your head.  
  JUDGE REASON: Answer uses simple, everyday language, no jargon, and is clear enough to understand without extra explanation.
- **victorian / vict-05|historical|deep|anthropic** (tier deep, model anthropic)  
  lexical delta `+0.150` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: The happiest women, like the happiest nations, have no history; and the years that bring the philosophic mind are years that take away the keenness of joy.  
  ANSWER: Maggie is growing up, and her life is getting harder and more complicated. George Eliot is saying that a simple, quiet life with nothing much happening is actually the happiest kind, even if it sounds boring. The line "happiest nations have no history" means that countries only end up in the history books because something terrible happened to them, like a war or a disaster. The same goes for peop  
  JUDGE REASON: The answer explains the source in everyday language, avoiding difficult terms and providing clear examples, so a reader who struggled with the original would understand it without a dictionary. It uses simpler vocabulary, stays free of jargon, and does not require further explanation.
- **victorian / vict-05|explain|brief|local** (tier brief, model local)  
  lexical delta `+0.139` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: The happiest women, like the happiest nations, have no history; and the years that bring the philosophic mind are years that take away the keenness of joy.  
  ANSWER: Happy people usually have no past to worry about, but thinking deeply makes you lose your ability to feel pure joy. The sentence compares women to countries, saying that while deep thought brings wisdom, it also dulls the sharp feeling of happiness.  
  JUDGE REASON: Answer uses simpler words, no jargon, and is understandable without a dictionary.
- **victorian / vict-03|explain|brief|local** (tier brief, model local)  
  lexical delta `+0.119` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: The greatest thing a human soul ever does in this world is to see something, and tell what it saw in a plain way; for hundreds can talk for one who can think, but thousands can think for one who can see.  
  ANSWER: The most important job a person can do is to look at something and describe it simply. Many people can talk, but only a few can think, while even more people can think if someone shows them what they actually saw. The **plain way** means speaking clearly so everyone understands.  
  JUDGE REASON: The answer is simpler, clear, and free of jargon, so a reader would understand it without extra help.
- **victorian / vict-08|historical|deep|anthropic** (tier deep, model anthropic)  
  lexical delta `+0.103` | judge score `4` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: Therefore, when we build, let us think that we build for ever; let it not be for present delight nor for present use alone; let it be such work as our descendants will thank us for.  
  ANSWER: Ruskin wrote this during a time when cities across Britain were tearing down old buildings and throwing up cheap new ones as fast as possible, all to keep up with factories, railways, and a booming population. Most builders and city planners thought only about what was needed right now, at the lowest cost. Ruskin hated that. When he says "our descendants will thank us for," he means the people who  
  JUDGE REASON: The answer uses contemporary, everyday language that is easier to grasp than the archaic phrasing of the source. It avoids specialized jargon and explains the idea directly, so a reader who struggled with the source would understand it without a dictionary. The wording is simple, clear, and self‑contained, requiring no further explanation.
- **victorian / vict-08|explain|deep|anthropic** (tier deep, model anthropic)  
  lexical delta `+0.100` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: Therefore, when we build, let us think that we build for ever; let it not be for present delight nor for present use alone; let it be such work as our descendants will thank us for.  
  ANSWER: Ruskin is saying that when people put up a building, they should treat it as a gift to the future, not just a convenience for themselves right now. Most people build to solve today's problem cheaply and quickly, then move on. He wants builders to stop and ask: will the people who come after us, our grandchildren and their grandchildren, be glad this was built? **Build as if the building will outli  
  JUDGE REASON: The tutor’s answer uses everyday language, avoids archaic or technical terms, and explains the idea in a straightforward way that a reader who found the source difficult would grasp without extra help.
- **victorian / vict-03|vocabulary|brief|local** (tier brief, model local)  
  lexical delta `+0.087` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: The greatest thing a human soul ever does in this world is to see something, and tell what it saw in a plain way; for hundreds can talk for one who can think, but thousands can think for one who can see.  
  ANSWER: **plain way**: using simple words that anyone can understand
**human soul**: the part of a person that thinks and feels
**thousands**: a very large number of people  
  JUDGE REASON: q1: Yes, the answer is understandable without a dictionary. q2: Yes, it uses simpler words. q3: Yes, no jargon. q4: No, it doesn't need explanation.
- **victorian / vict-04|historical|deep|anthropic** (tier deep, model anthropic)  
  lexical delta `+0.069` | judge score `4` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: Under all speech that is good for anything there lies a silence that is better; silence is deep as eternity, speech is shallow as time.  
  ANSWER: Carlyle wrote this during a time when newspapers, pamphlets, and public speeches were everywhere, and many people felt that talking and writing had gotten out of hand, that words were being used to fill space rather than say anything real. So when he writes that "silence is deep as eternity, speech is shallow as time," he is saying that the things worth knowing most, the big truths about life and   
  JUDGE REASON: The answer uses everyday language and avoids technical jargon; it explains the source in plain terms that a reader could grasp without a dictionary. It is slightly longer and more detailed than the source, but still simpler overall. It does not require further explanation.
- **victorian / vict-05|explain|brief|anthropic** (tier brief, model anthropic)  
  lexical delta `+0.058` | judge score `4` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: The happiest women, like the happiest nations, have no history; and the years that bring the philosophic mind are years that take away the keenness of joy.  
  ANSWER: The happiest people live such peaceful, uneventful lives that there is nothing dramatic to write down about them, just as peaceful countries rarely make the history books. The **bitter trade-off** is that growing wiser with age also means feeling joy less sharply, so the very years that teach you to understand life quietly steal the thrill of living it.  
  JUDGE REASON: The answer uses mostly everyday words and avoids academic jargon, but includes a few slightly more figurative terms such as "bitter trade‑off" and "uneventful" that may be marginally harder than the source. It is understandable without a dictionary and does not require further explanation.
- **victorian / vict-04|explain|brief|local** (tier brief, model local)  
  lexical delta `+0.041` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: Under all speech that is good for anything there lies a silence that is better; silence is deep as eternity, speech is shallow as time.  
  ANSWER: Good words always rest on a quiet that is much deeper than the words themselves. While talking only lasts as long as time, silence is as endless as eternity. The hard part is seeing that quiet is more powerful than noise.  
  JUDGE REASON: The answer uses everyday words and clear comparisons that mirror the source’s meaning, so a reader who struggled with the source would understand it without a dictionary. It simplifies the language, avoids jargon, and is self‑explanatory.
- **victorian / vict-05|socratic|deep|anthropic** (tier deep, model anthropic)  
  lexical delta `+0.032` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: The happiest women, like the happiest nations, have no history; and the years that bring the philosophic mind are years that take away the keenness of joy.  
  ANSWER: 1. The passage says the happiest women "have no history" — but what does it mean to have no history, and why would that make someone happier?

2. It then says the years that bring a "philosophic mind" — meaning the years that teach you to think deeply — also take away the sharpness of joy. So what is it about thinking deeply that might dull happiness?

3. If deep thinking and real happiness pull a  
  JUDGE REASON: The answer uses everyday language, explains terms, and poses clear questions.
- **victorian / vict-04|explain|deep|anthropic** (tier deep, model anthropic)  
  lexical delta `+0.022` | judge score `5` q3(no-register)=`True` | jargon lemmas: ['unspeak']  
  SOURCE: Under all speech that is good for anything there lies a silence that is better; silence is deep as eternity, speech is shallow as time.  
  ANSWER: Carlyle is saying that the most important things cannot actually be put into words. Whatever you manage to say out loud is only a thin slice of what is really true. The part that stays unspoken, the part that sits underneath all the words, is deeper and more real than anything language can carry.

Think of it this way: when someone you love dies, the feeling inside you is enormous. Any sentence yo  
  JUDGE REASON: The answer uses everyday language, simple words, no jargon, and is understandable without a dictionary.
- **victorian / vict-05|socratic|brief|anthropic** (tier brief, model anthropic)  
  lexical delta `+0.005` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: The happiest women, like the happiest nations, have no history; and the years that bring the philosophic mind are years that take away the keenness of joy.  
  ANSWER: What does the passage say happens to a person's ability to feel sharp happiness as they grow wiser and gain more experience of life?  
  JUDGE REASON: The question is phrased in everyday language, avoiding the abstract terms of the source and requiring no further explanation.

## All judge-added harder catches

- **archaic / arch-06|historical|deep|anthropic** (tier deep, model anthropic)  
  lexical delta `-0.488` | judge score `2` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: I write of melancholy, by being busy to avoid melancholy. There is no greater cause of melancholy than idleness, no better cure than business.  
  ANSWER: Burton is talking about a real problem people faced in his time: too much free time was seen as genuinely dangerous to your health, not just boring. Doctors and thinkers back then believed that an idle mind would turn in on itself and breed dark, heavy thoughts, what they called melancholy, meaning a kind of deep sadness or gloom that could make you sick. So when Burton says he writes about melanc  
  JUDGE REASON: The tutor’s answer uses several words and phrases that are more complex than those in the very simple source passage, such as ‘genuinely’, ‘dangerous’, ‘breed’, ‘medicine’, and ‘clever point’. A reader who struggled with the source would likely find the answer harder to understand without a dictionary. The answer does not employ simpler vocabulary than the source, but it also avoids heavy academic
- **archaic / arch-03|historical|deep|anthropic** (tier deep, model anthropic)  
  lexical delta `-0.337` | judge score `3` q3(no-register)=`True` | jargon lemmas: ['unexplore']  
  SOURCE: We carry within us the wonders we seek without us: there is all Africa and her prodigies in us; we are that bold and adventurous piece of nature.  
  ANSWER: In Browne's time, European explorers were sailing to Africa and the Americas and coming back with wild stories about strange animals, strange peoples, and strange lands. People called these things "prodigies," meaning wonders or freaks of nature that seemed almost impossible. There was a real craze for collecting and reading about these curiosities from far-off places.

Browne is saying: you do no  
  JUDGE REASON: The tutor’s answer is mostly plain, but it introduces a few slightly more advanced words (e.g., "curiosities", "exotic", "jaw‑dropping") that a reader who struggled with the source might find a bit harder. It does not use simpler words than the source, but it stays free of academic jargon and does not require further explanation.
- **irony / iron-09|vocabulary|deep|anthropic** (tier deep, model anthropic)  
  lexical delta `-1.161` | judge score `0` q3(no-register)=`None` | jargon lemmas: none  
  SOURCE: Patience, n. A minor form of despair, disguised as a virtue.  
  ANSWER: **despair** and **virtue** are doing all the work here.

Despair means giving up all hope, feeling like nothing will ever get better. That is usually seen as one of the worst things a person can feel. A virtue is a good quality, something people admire and try to have, like kindness or courage.

Bierce is saying that when you are patient, you have actually already given up inside. You have stopped  
  JUDGE REASON: unparseable judge output
- **irony / iron-05|explain|deep|anthropic** (tier deep, model anthropic)  
  lexical delta `-0.002` | judge score `2` q3(no-register)=`False` | jargon lemmas: ['snobbish']  
  SOURCE: To lose one parent may be regarded as a misfortune; to lose both looks like carelessness.  
  ANSWER: Lady Bracknell is not actually talking about grief or bad luck. She means that Jack has no known parents at all, and she finds that socially unacceptable. But she words it as if losing parents were something a careless person simply lets happen, the way you might lose an umbrella or a glove.

**The joke is that she treats a serious personal fact like a silly personal failing.** Losing both parents  
  JUDGE REASON: The tutor’s answer uses more complex vocabulary and longer sentences than the source, making it harder for a reader who found the source difficult. It is not simpler, contains some literary terms, and could benefit from further explanation.
- **irony / iron-05|historical|deep|anthropic** (tier deep, model anthropic)  
  lexical delta `-0.082` | judge score `2` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: To lose one parent may be regarded as a misfortune; to lose both looks like carelessness.  
  ANSWER: Lady Bracknell says this to Jack after finding out he was abandoned as a baby in a handbag at a train station, with no known parents at all. She is not actually talking about parents dying. She means Jack has no family background she can trace, and in her world, a good family name was everything. Without one, you simply could not marry into a respectable household.

The joke works because she talk  
  JUDGE REASON: The answer uses more complex vocabulary and longer sentences than the simple source, so a reader who struggled with the source would likely need a dictionary to understand it fully.
- **irony / iron-05|vocabulary|deep|anthropic** (tier deep, model anthropic)  
  lexical delta `-0.289` | judge score `2` q3(no-register)=`True` | jargon lemmas: ['misplace']  
  SOURCE: To lose one parent may be regarded as a misfortune; to lose both looks like carelessness.  
  ANSWER: **Carelessness** is the word doing all the work here. Today it just means not paying attention, like forgetting your keys. But in Wilde's time it also carried a sharper edge: it meant failing to take proper care of something that was your responsibility. Parents were not things you were supposed to misplace.

The joke works because "losing" a parent normally means they died, which is sad and nobod  
  JUDGE REASON: The tutor’s answer uses many more words and figurative language than the brief source sentence, making it harder for a reader who struggled with the source to understand without a dictionary. It does not use simpler words; it introduces terms like "sharper edge," "misplace," and "polite tone," which are more complex than the source’s vocabulary. The language is largely free of academic jargon, tho
- **irony / iron-05|explain|deep|local** (tier deep, model local)  
  lexical delta `-0.691` | judge score `2` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: To lose one parent may be regarded as a misfortune; to lose both looks like carelessness.  
  ANSWER: Losing one parent is sad because it is a bad thing that happens to you. But losing both parents looks like carelessness because it seems like the other person did not try hard enough to save the first one. The joke here is that death is not something anyone can plan or control, yet the speaker treats it like a mistake in a game. He is making fun of how people talk about serious problems. Instead o  
  JUDGE REASON: The tutor’s answer is longer and uses more complex vocabulary and explanations than the brief, simple source sentence. It would not be understood by a reader who struggled with the source without a dictionary, and it does not use simpler words. It avoids heavy jargon, but it does require its own explanation. Overall, it is only somewhat plain compared to the source.
- **irony / iron-08|explain|deep|local** (tier deep, model local)  
  lexical delta `-0.543` | judge score `3` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: She had a great taste for keeping up appearances, and would have considered herself disgraced had she been seen riding in any but a hired carriage.  
  ANSWER: She really cared about looking rich and important, even if she wasn't. She would feel ashamed if people saw her in a simple car instead of a fancy one she rented just to look good. This shows how much she worried about what others thought of her. She wanted everyone to believe she had money and status, so she spent her time and money on things that made her look successful. It is like a kid who bu  
  JUDGE REASON: The answer expands on the source with more detail and some figurative language, making it slightly harder to grasp for a reader who struggled with the original. It does not use simpler vocabulary overall, but it stays free of academic jargon and does not require further explanation.
- **philosophy / phil-12|historical|deep|anthropic** (tier deep, model anthropic)  
  lexical delta `-0.932` | judge score `3` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: The mass of men lead lives of quiet desperation. What is called resignation is confirmed desperation.  
  ANSWER: Most people in Thoreau's time worked long hours at jobs they hated, just to pay off debts on land or tools or houses they had bought on credit. They felt trapped but never said so out loud. They just kept going, heads down, day after day. That silence is what Thoreau means by "quiet" desperation, a deep unhappiness that nobody talks about.

The second sentence is the sharper one. When people final  
  JUDGE REASON: The answer is mostly plain and understandable, but it uses longer sentences and some words that are a bit more complex than those in the very simple source, so it is slightly less plain than the source.
- **technical / tech-07|historical|deep|anthropic** (tier deep, model anthropic)  
  lexical delta `-0.507` | judge score `1` q3(no-register)=`False` | jargon lemmas: none  
  SOURCE: Whatever has any beginning has a cause; and whatever has not had a cause must be eternal, for that which begins to exist must owe its existence to something prior.  
  ANSWER: Mill is walking through one of the oldest arguments for God's existence: the universe had a beginning, so it must have had a cause, and that cause is God. The line "that which begins to exist must owe its existence to something prior" is the key step. It says nothing can just pop into being on its own; something earlier must have made it happen.

The debate Mill is answering goes back centuries. I  
  JUDGE REASON: The tutor’s answer expands on the source with more complex ideas, vocabulary, and academic references, making it harder to understand without additional explanation.
- **technical / tech-10|historical|deep|local** (tier deep, model local)  
  lexical delta `-0.716` | judge score `2` q3(no-register)=`False` | jargon lemmas: none  
  SOURCE: The fluid part of the flame is continually rising and being consumed, and the heat decomposes the wax into substances that burn with that bright light.  
  ANSWER: The candle flame works like a busy factory where the liquid wax floats up to the top and gets used up. The heat from the fire breaks the solid wax into smaller pieces that can burn brightly. This happens because the heat splits the wax into parts that release light. Faraday explains this to show that the fire is not just a single thing but a process where the wax changes and moves. He answers the   
  JUDGE REASON: The tutor’s answer uses more complex wording and references (e.g., ‘Faraday’, ‘burning gas’) that a reader who struggled with the simple source would likely find confusing. It is not simpler than the source, contains some jargon, and would benefit from its own explanation. Overall, it is noticeably less plain than the source.
- **victorian / vict-06|explain|deep|anthropic** (tier deep, model anthropic)  
  lexical delta `-0.761` | judge score `0` q3(no-register)=`None` | jargon lemmas: none  
  SOURCE: It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness, it was the epoch of belief, it was the epoch of incredulity.  
  ANSWER: Dickens is saying that the same moment in history felt completely opposite depending on who you were and what was happening to you. The rich and powerful might have called it a golden age, full of progress and hope. The poor and suffering would have called it a nightmare. Both were right at the same time, about the same world.

**The deeper point is that big, world-shaking times are never just one  
  JUDGE REASON: unparseable judge output
- **victorian / vict-11|historical|deep|anthropic** (tier deep, model anthropic)  
  lexical delta `-0.119` | judge score `1` q3(no-register)=`False` | jargon lemmas: none  
  SOURCE: The pursuit of perfection, then, is the pursuit of sweetness and light. He who works for sweetness and light united, works to make reason and the will of God prevail.  
  ANSWER: Arnold borrowed "sweetness and light" from the writer Jonathan Swift, who used it to describe what bees give the world: honey and the light from beeswax candles. Arnold grabbed that image to stand for two things he thought England badly needed: beauty ("sweetness") and clear, honest thinking ("light"). England in the 1860s was full of people who were very busy and very confident, building factorie  
  JUDGE REASON: Source is simple; answer uses more complex words and references; answer contains literary references; answer is explanatory and needs dictionary.
- **victorian / vict-01|socratic|brief|local** (tier brief, model local)  
  lexical delta `-1.115` | judge score `2` q3(no-register)=`False` | jargon lemmas: none  
  SOURCE: Fog everywhere. Fog up the river, where it flows among green aits and meadows; fog down the river, where it rolls defiled among the tiers of shipping and the waterside pollutions of a great and dirty city.  
  ANSWER: Why does the author say the fog is "defiled" and rolls among "pollutions" instead of just saying the city is dirty?  
  JUDGE REASON: The tutor’s answer is a single Socratic question that repeats the non‑plain words from the source (“defiled”, “pollutions”). A reader who found the source hard would still need a dictionary for those terms, so the answer is not simpler or more accessible. It also contains literary jargon and does not avoid it. The question itself does not explain anything, but it uses the same non‑plain vocabulary
