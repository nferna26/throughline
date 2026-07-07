# CORE-1169 human-review worksheet (Nick)

Grade each ANSWER against the 8th-grade plain-language bar: is it as easy as or easier than the SOURCE, with no undefined hard words? Write PLAIN or HARDER in the call column. The machine verdict is shown so you can spot disagreements.

## A) Overrides the machine cleared (spot-check the green)

- **archaic / arch-01|explain|brief|local** (tier brief, model local)  
  lexical delta `+0.075` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: As I walked through the wilderness of this world, I lighted on a certain place where was a den, and laid me down in that place to sleep; and as I slept, I dreamed a dream.  
  ANSWER: The narrator says he traveled through a hard place called the wilderness and found a hole to sleep in before falling asleep and dreaming. The word **den** just means a small cave or hiding spot where animals live, which shows how small and safe his resting place was. This simple story starts by telling us that the main events of the book happen inside a dream while he rests.  
  JUDGE REASON: The tutor’s answer uses everyday, simple words, avoids archaic or academic terms, and conveys the meaning directly, so a reader who struggles with the source can understand it without extra help.
  YOUR CALL: ____________

- **archaic / arch-07|explain|brief|anthropic** (tier brief, model anthropic)  
  lexical delta `+0.024` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: What song the Sirens sang, or what name Achilles assumed when he hid himself among women, though puzzling questions, are not beyond all conjecture.  
  ANSWER: Two old riddles from Greek myths get name-dropped here: the Sirens were magical creatures whose singing lured sailors to their deaths, and Achilles once disguised himself as a girl to hide from a war. Browne's **real point** is a sly one: even mysteries that seem totally unsolvable can still be guessed at with careful thinking.  
  JUDGE REASON: The answer uses everyday words, explains the source plainly, and contains no jargon, so it is easily understood without extra explanation.
  YOUR CALL: ____________

- **archaic / arch-09|historical|deep|anthropic** (tier deep, model anthropic)  
  lexical delta `+0.195` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: As good almost kill a man as kill a good book: who kills a man kills a reasonable creature, but he who destroys a good book kills reason itself.  
  ANSWER: Milton wrote this in 1644 to fight a law that made printers get government approval before publishing anything. The people running England at the time could simply block any book they disliked. Milton thought that was as bad as murder, which is why he says "kills reason itself." A person who dies still leaves their ideas behind in others, but a book that never gets printed takes its ideas with it   
  JUDGE REASON: The tutor’s answer uses modern, everyday language, avoids archaic or academic terms, and explains the source in a way that a reader who found the original passage difficult would understand without needing a dictionary. It is straightforward, free of jargon, and does not require further explanation.
  YOUR CALL: ____________

- **irony / iron-01|explain|deep|anthropic** (tier deep, model anthropic)  
  lexical delta `+0.058` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: I have been assured that a young healthy child well nursed is at a year old a most delicious, nourishing, and wholesome food, whether stewed, roasted, baked, or boiled.  
  ANSWER: Swift is not actually suggesting people eat babies. He is pretending to be a calm, reasonable expert who has done his homework, and he uses that fake calm to make a point about how the English treated poor Irish people. The shocking part is that he describes a child the same way you would describe a chicken or a pot roast, listing cooking methods like it is a recipe. **That gap between the horror   
  JUDGE REASON: The tutor’s answer uses everyday, modern language that is simpler than the archaic source, avoids academic jargon, and is clear enough that a reader could understand it without extra explanation.
  YOUR CALL: ____________

- **irony / iron-02|vocabulary|brief|anthropic** (tier brief, model anthropic)  
  lexical delta `+0.157` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.  
  ANSWER: **universally acknowledged**: everyone agrees, no exceptions, no argument allowed.
**in want of**: needing, lacking something he does not yet have.

The sentence also says the opposite of what it means: it pretends this is a fact everyone agrees on, but really it is poking fun at people who assume every rich single man must be hunting for a wife.  
  JUDGE REASON: The tutor’s answer uses everyday words, explains the phrases plainly, avoids jargon, and is clear enough that a reader who struggled with the original line would understand it without a dictionary.
  YOUR CALL: ____________

- **irony / iron-04|historical|brief|local** (tier brief, model local)  
  lexical delta `+0.060` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: October. This is one of the peculiarly dangerous months to speculate in stocks. The others are July, January, September, April, November, May, March, June, December, August, and February.  
  ANSWER: This list shows that the writer thinks every single month is risky for trading stocks, which is a strange idea because usually only October is known to be dangerous. The writer is making a joke by listing all twelve months as if they are all equally bad times to gamble on the stock market.  
  JUDGE REASON: Answer uses simple, everyday words, avoids jargon, and is clear enough that no extra explanation is needed.
  YOUR CALL: ____________

- **philosophy / phil-04|historical|brief|anthropic** (tier brief, model anthropic)  
  lexical delta `+0.047` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: The only freedom which deserves the name is that of pursuing our own good in our own way, so long as we do not attempt to deprive others of theirs.  
  ANSWER: No special context is needed here. Mill is saying that real freedom means doing what you think is good for yourself, as long as you don't stop other people from doing the same for themselves.  
  JUDGE REASON: The answer uses everyday language, avoids jargon, and is clear enough for a reader who struggled with the source.
  YOUR CALL: ____________

- **philosophy / phil-05|socratic|brief|anthropic** (tier brief, model anthropic)  
  lexical delta `+0.081` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: Reason is, and ought only to be the slave of the passions, and can never pretend to any other office than to serve and obey them.  
  ANSWER: When Hume says reason should "serve and obey" the passions, what job is he saying reason actually does for our feelings, according to this sentence?  
  JUDGE REASON: The question uses everyday words, no jargon, and is clear enough for a reader of the source.
  YOUR CALL: ____________

- **philosophy / phil-06|socratic|deep|local** (tier deep, model local)  
  lexical delta `+0.157` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: Man is a rope, tied between beast and overman, a rope over an abyss. What is great in man is that he is a bridge and not an end.  
  ANSWER: 1. What does it mean to say a person is just a rope hanging over a deep drop?
2. If we are a rope, why is it important to be a bridge instead of a final destination?
3. Does this mean we should keep moving toward something better, or is it okay to stop being a bridge?  
  JUDGE REASON: The answer uses everyday language, avoids jargon, and is understandable without a dictionary.
  YOUR CALL: ____________

- **technical / tech-08|explain|brief|anthropic** (tier brief, model anthropic)  
  lexical delta `+0.364` | judge score `5` q3(no-register)=`True` | jargon lemmas: ['unimaginably']  
  SOURCE: The present is the key to the past; the same agents which are now at work in modifying the earth's crust have been operating with like energy from time immemorial.  
  ANSWER: The forces reshaping the Earth today, like rivers, volcanoes, and erosion, have been doing the exact same job for an unimaginably long time. The tricky part is "**the present is the key to the past**," which sounds like a riddle but simply means: watch what nature does right now, and you can figure out how ancient rocks and landscapes were formed.  
  JUDGE REASON: The answer replaces technical terms with everyday language, explains the key phrase, and avoids jargon, making it easier to understand than the source.
  YOUR CALL: ____________

- **victorian / vict-02|vocabulary|deep|anthropic** (tier deep, model anthropic)  
  lexical delta `+0.220` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: If we had a keen vision and feeling of all ordinary human life, it would be like hearing the grass grow and the squirrel's heart beat, and we should die of that roar which lies on the other side of silence.  
  ANSWER: **"the other side of silence"** and **"keen vision and feeling"** both need unpacking here.

"Keen vision and feeling" means being able to notice and truly feel everything happening around you, every tiny thing, all at once. Today "keen" just means sharp or eager, but Eliot means something stronger: a kind of perfect, total awareness, like having every sense turned up as high as it can go.

The st  
  JUDGE REASON: The answer explains the difficult terms in plain language, uses simpler words, avoids jargon, and is self‑explanatory.
  YOUR CALL: ____________

- **victorian / vict-03|vocabulary|deep|local** (tier deep, model local)  
  lexical delta `+0.326` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: The greatest thing a human soul ever does in this world is to see something, and tell what it saw in a plain way; for hundreds can talk for one who can think, but thousands can think for one who can see.  
  ANSWER: The biggest job a person can do is to look at something and say exactly what they saw without making it hard to understand. Ruskin thinks seeing is rare because most people just let their minds wander while looking. They do not really watch. But if one person truly sees, they can help hundreds of others who cannot think clearly on their own. The word "plain" here means simple and clear, not boring  
  JUDGE REASON: The answer uses everyday words, explains the source’s meaning, avoids jargon, and is clear enough for a reader who struggled with the original passage.
  YOUR CALL: ____________

- **victorian / vict-05|socratic|brief|anthropic** (tier brief, model anthropic)  
  lexical delta `+0.005` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: The happiest women, like the happiest nations, have no history; and the years that bring the philosophic mind are years that take away the keenness of joy.  
  ANSWER: What does the passage say happens to a person's ability to feel sharp happiness as they grow wiser and gain more experience of life?  
  JUDGE REASON: The question is phrased in everyday language, avoiding the abstract terms of the source and requiring no further explanation.
  YOUR CALL: ____________

## B) Plain outputs the machine passed outright (spot-check the baseline)

- **archaic / arch-01|historical|brief|local** (tier brief, model local)  
  lexical delta `-1.539` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: As I walked through the wilderness of this world, I lighted on a certain place where was a den, and laid me down in that place to sleep; and as I slept, I dreamed a dream.  
  ANSWER: The author says he walked through the "wilderness of this world," which means he is comparing real life to a dangerous, empty desert. He then says he fell asleep and had a dream, meaning the whole story that follows is just a story inside a story.  
  JUDGE REASON: The answer uses modern, simple language, no jargon, and explains the passage clearly, so a reader who struggled with the source would understand it without a dictionary.
  YOUR CALL: ____________

- **archaic / arch-07|explain|brief|local** (tier brief, model local)  
  lexical delta `-0.515` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: What song the Sirens sang, or what name Achilles assumed when he hid himself among women, though puzzling questions, are not beyond all conjecture.  
  ANSWER: The author says we can guess the answers to these old riddles because they are not impossible to solve. He calls them "puzzling questions," which just means they are tricky, but he believes we can still figure them out.  
  JUDGE REASON: The answer uses everyday words, avoids jargon, and explains the source in simple terms that a reader who struggled with the original would grasp without a dictionary.
  YOUR CALL: ____________

- **irony / iron-01|explain|brief|local** (tier brief, model local)  
  lexical delta `-0.549` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: I have been assured that a young healthy child well nursed is at a year old a most delicious, nourishing, and wholesome food, whether stewed, roasted, baked, or boiled.  
  ANSWER: The author claims babies are tasty food, but this is a terrible joke meant to show how cruel it is to treat people like animals. He lists cooking methods like stewed or roasted to make the idea sound normal, which makes the horror of eating children even clearer.  
  JUDGE REASON: Answer uses everyday language, no jargon, and is understandable.
  YOUR CALL: ____________

- **irony / iron-08|socratic|brief|anthropic** (tier brief, model anthropic)  
  lexical delta `-0.742` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: She had a great taste for keeping up appearances, and would have considered herself disgraced had she been seen riding in any but a hired carriage.  
  ANSWER: What does riding in a hired carriage instead of her own carriage tell you about how this woman wants other people to see her, even if she can't really afford it?  
  JUDGE REASON: The question uses everyday language, avoids jargon, and is simpler than the source. It can be understood without a dictionary and does not require further explanation.
  YOUR CALL: ____________

- **philosophy / phil-01|explain|brief|anthropic** (tier brief, model anthropic)  
  lexical delta `-3.017` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: The transcendental unity of apperception is that unity through which all the manifold given in an intuition is united in a concept of the object.  
  ANSWER: **The "I" that ties everything together**: your mind has one constant sense of "me" that grabs all the separate bits your senses pick up, say colors, shapes, sounds, and bundles them into one single thing, like "that is a dog." The tricky part is "apperception," which just means your awareness of your own thinking self, the part of you that knows it is you doing the noticing.  
  JUDGE REASON: The answer uses everyday words, explains the key term, and avoids jargon, making it understandable without a dictionary.
  YOUR CALL: ____________

- **philosophy / phil-06|vocabulary|deep|local** (tier deep, model local)  
  lexical delta `-0.399` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: Man is a rope, tied between beast and overman, a rope over an abyss. What is great in man is that he is a bridge and not an end.  
  ANSWER: This line uses two big ideas to tell us how to live. First, it calls a person a "rope." Today, a rope is just a string for tying things. But here, it means a person is a connection between two things: the animal we were and the "overman," which is a better, higher version of ourselves. The "abyss" is a deep, scary drop, like a hole in the ground. This means life is dangerous and there is no safety  
  JUDGE REASON: The tutor’s answer explains the poetic terms in everyday language, avoids jargon, and uses simpler words than the source. It is understandable without a dictionary and does not require further explanation.
  YOUR CALL: ____________

- **technical / tech-01|explain|brief|local** (tier brief, model local)  
  lexical delta `-0.839` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: It is interesting to contemplate an entangled bank, clothed with many plants of many kinds, with birds singing on the bushes, and to reflect that these elaborately constructed forms have all been produced by laws acting around us.  
  ANSWER: It is amazing to think that all these complex plants, birds, and bushes grew from simple laws we can see. The hard part is realizing nature built them without anyone planning it, just by following rules that work everywhere.  
  JUDGE REASON: The answer uses simpler, everyday language and avoids jargon, making it easier to understand than the source.
  YOUR CALL: ____________

- **technical / tech-06|vocabulary|deep|anthropic** (tier deep, model anthropic)  
  lexical delta `-0.958` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: I could exceedingly plainly perceive it to be all perforated and porous, much like a honeycomb; these pores, or cells, were the first microscopical pores I ever saw.  
  ANSWER: **Microscopical**: Hooke means "seen only through a microscope." Today we say "microscopic," and it just means very tiny. But Hooke is using it to say something more specific: these pores were not just small, they were invisible to the naked eye and only showed up because of his new instrument. That matters because he is marking a moment, the first time anyone had ever looked at a slice of cork th  
  JUDGE REASON: The answer uses simpler, everyday words, avoids jargon, and explains the term clearly, so a reader can understand it without extra help.
  YOUR CALL: ____________

- **victorian / vict-01|explain|brief|local** (tier brief, model local)  
  lexical delta `-0.789` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: Fog everywhere. Fog up the river, where it flows among green aits and meadows; fog down the river, where it rolls defiled among the tiers of shipping and the waterside pollutions of a great and dirty city.  
  ANSWER: The fog covers the clean green fields and the dirty city ships alike, showing how pollution spreads everywhere. This **defiled** water means the river is made unclean by the city's waste, mixing nature and grime into one gray mess.  
  JUDGE REASON: The answer uses simpler, everyday words, avoids jargon, and is clear enough that a reader who struggled with the poetic source would understand it without extra explanation.
  YOUR CALL: ____________

- **victorian / vict-08|historical|deep|local** (tier deep, model local)  
  lexical delta `-0.306` | judge score `5` q3(no-register)=`True` | jargon lemmas: none  
  SOURCE: Therefore, when we build, let us think that we build for ever; let it not be for present delight nor for present use alone; let it be such work as our descendants will thank us for.  
  ANSWER: Ruskin tells us to stop building just for today's fun or to help us right now. Instead, he wants us to imagine we are building for everyone who will live after us. He says we should make things that our children and grandchildren will thank us for. This matters because if we only care about what looks good today, we might ruin the world for the future. Ruskin believes that true greatness comes fro  
  JUDGE REASON: The answer uses everyday language, avoids archaic terms, and is straightforward.
  YOUR CALL: ____________

