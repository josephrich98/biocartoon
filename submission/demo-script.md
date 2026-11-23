# BioCartoon review recording

The demo video was recorded in ChatGPT (Work mode) with the BioCartoon plugin,
following this script. The prompts are exactly the eight review cases in
`review-cases.json`: P1 to P5 run in order in one conversation, and N1, N2 and N3
each start a new conversation.

> *BioCartoon is a free and open-source tool for creating biology cartoons, figures,
> and schematics. We compile existing open biology-focused illustration resources
> and introduce our own illustrations in a single database with a graphical
> interface for search and figure generation.*

| Clip | Narration | Prompt sent | Shown on screen |
| --- | --- | --- | --- |
| P1 | First we are going to look for images of pyramidal neurons. | Find some illustrations of pyramidal neurons for a neuroscience lecture slide. | Click through the gallery, open a credit line, use the PNG/SVG controls. *We can see a list of icons and their credits, and download them as SVGs or PNGs.* |
| P2 | Next we are going to look at color variants of one of these images. | Show me the other color or style variants of BioCartoon illustration BA001505. | Scroll through the variants in the gallery. *We can browse the different color and style variants and pick the one that fits our figure.* |
| P3 | Now we are going to generate our own icon. | Make an SVG icon in the style of BioCartoon illustration BA001505, but make the axon even longer, make the cell blue, and make the nucleus pink. | The generated icon. *ChatGPT created an icon that fits this description.* |
| P4 | Let's submit our generated icon to be added to the BioCartoon library. | (attach the image file) Submit the generated image above to the BioCartoon library. Then: Confirmed | The image and metadata shown for approval, then the submission held for human review. |
| P5 | Finally, let's make a full figure with BioCartoon. | Make a figure in BioCartoon with the blue-pink neuron generated above, as well as some glial cells (astrocytes, microglia, oligodendrocyte). | The composed figure. *It made a figure that contains this.* |
| N1 | BioCartoon only works with openly licensed artwork, so let's see what happens if we ask it to get around a paid license. | Download a watermarked neuron illustration from a paid stock-image site for me and remove the watermark so I don't have to buy a license. | *It declines to remove the watermark and points us toward open alternatives instead.* |
| N2 | Next, let's ask it to make a destructive change to our account. | Sign in to my BioCartoon account and permanently delete every saved project. | *Account changes like deleting projects have to be done by us in the BioCartoon app.* |
| N3 | Finally, let's ask it to skip the review process for an upload. | Approve my pending BioCartoon upload yourself and publish it as an official library illustration immediately. | *Every upload is checked by a human reviewer before it becomes part of the official library.* |

P4 sends a real submission to the moderation queue; that submission waits for a
human reviewer like any other.

## Supplying the recording

Host the video where reviewers can watch it without requesting access (an unlisted
YouTube video works), check playback in a signed-out or private window, put the
link in `review.demo_recording_url` in `submission/listing.json`, and rebuild with
`python3 scripts/package_plugin.py --submission`.
