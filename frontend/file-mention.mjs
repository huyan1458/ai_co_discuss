// An @ naming a project file or folder, as the composer's @ menu writes it: a path with a "/" or a file extension. The
// boundaries match the page's own @ parsing; group 1 is what precedes the @, group 2 the mention. Shared by the sent
// message (markdown.mjs, on escaped text) and the draft's painted copy (ChannelDiscussion.vue).
const PATH_CHARACTER = "[^\\s@`，,。；;：:、！？!?()（）<>&\"'#]";
export const FILE_MENTION_PATTERN = new RegExp(
  `(^|[\\s(（，,。；;：:、])(@(?:${PATH_CHARACTER}+/${PATH_CHARACTER}*|${PATH_CHARACTER}+\\.[A-Za-z][A-Za-z0-9]{0,9}))(?=$|[\\s)），,。；;：:、！？!?])`, "gu");
