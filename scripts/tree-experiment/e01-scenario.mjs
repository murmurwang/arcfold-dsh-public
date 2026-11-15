// Synthetic user originals and review criteria, frozen before any E01 call.
// Expected judgments and UI controls are never included in the model request.
export function e01Scenario() {
  const goals = [
    { label: '自然观察活动', laterName: '我筹备雨天可改期的自然观察', turns: [
      '我准备组织一次社区自然观察活动。这是一个独立事项，参加者多数没有观察经验。先帮我列出要确定的三件事，不要查网或联系别人。',
      '关于自然观察活动：以后给这个事项提建议，先说对初次参加的人有什么影响，再说组织方是否方便。请比较公园慢行和室内看照片两种形式。',
      '关于自然观察活动：我决定先按公园慢行准备，室内照片方案只是备用，还没有启用。',
      '关于自然观察活动：现在新增一项条件，下雨就改期，不再采用室内备用。这个条件是刚决定的，之前不是这个要求。',
      '关于自然观察活动：请按已经约定的方式，给出集合地点的两种选择；不用替我作最终决定。',
      '关于自然观察活动：我选公园北门，原因是第一次来的人容易辨认。南门只是比较过的备选。',
      '关于自然观察活动：现在请再列一次当天的三步流程，这只是本次操作，不增加长期规则。',
      '关于自然观察活动：先不增加观察物种清单，保持三步流程；人数还没定，不要写成已经确定。',
      '关于自然观察活动：本轮只核对已决定和仍待定的内容，各用一句话。准备工作仍在进行。',
      '关于自然观察活动：人数现在定为六人。请给出最终准备摘要，保留雨天改期条件；实际活动还没有举行。',
    ] },
    { label: '家庭相册', laterName: '我筹备不带人名的家庭相册', turns: [
      '另开一个独立事项，我要筹备整理一本家庭相册。目前只有照片清单，没有上传照片；请帮我比较按年份和按主题两种结构，不要读取文件。',
      '关于家庭相册：以后先说明每种编排会让读者看到什么故事，再说制作是否省事。请用两句话继续比较。',
      '关于家庭相册：我决定按年份编排，按主题仍只是没有采用的建议。',
      '关于家庭相册：新增要求，标题不出现人名，只写年份和地点。这是现在才加的要求，不是在说之前的标题有错。',
      '关于家庭相册：请给两种封面标题的写法，遵守刚加的要求，先不要替我选择。',
      '关于家庭相册：我选“春天的海边”，年份放副标题。另一种保留作备选，没有采纳。',
      '关于家庭相册：请再做一份排版步骤清单，和刚才一样只在聊天里给出，不创建文件。',
      '关于家庭相册：照片数量还没有点完，不能说相册已制作完成；目前只是确定编排方式。',
      '关于家庭相册：把已经决定的编排和待定的照片数量分别说清，先不要推进印刷。',
      '关于家庭相册：照片清单数量现在核对为二十张。请整理准备阶段的最终摘要；照片排版和印刷尚未执行。',
    ] },
    { label: '阳台植物', turns: [
      '还有第三个独立事项，我想为在阳台养几盆观赏植物做准备。阳台只有上午有阳光，请先列要观察的两件事，不要购物或查网。',
      '关于阳台植物：以后每项建议先写依据是什么、还有什么不知道，再给行动；不要把缺信息时的猜测写成确定结论。',
      '关于阳台植物：我决定先记录一周日照再选植物；现在没有决定任何品种。',
      '关于阳台植物：补充新条件，我周中只能晚上照看，周末时间较多。这项限制只适用于阳台植物这件事。',
      '关于阳台植物：请按已约定的方式列一份观察表的栏目，只在回复里给表头。',
      '关于阳台植物：我选择记录直射时段和风力感受；空气湿度暂不记录，不是说它永远没有价值。',
      '关于阳台植物：请再次列出这两个栏目，并各给一个填写示例；这是正常使用现有做法。',
      '关于阳台植物：目前只记录了三天，不能说一周观察完成，也不要现在推荐购买品种。',
      '关于阳台植物：只总结观察计划和当前进度，区别已记录三天与还需要四天。',
      '关于阳台植物：观察计划已确认，这个准备阶段可以结束；一周记录本身还没完成。请把两者区分清楚。',
    ] },
  ];
  return {
    id: 'system-e01-dev-v1', independentHeldout: false,
    goals, turns: Array.from({ length: 30 }, (_, index) => ({ ordinal: index + 1, goal: index % 3, text: goals[index % 3].turns[Math.floor(index / 3)] })),
    uiActions: { renameAfterTurns: 15, renameReason: 'Synthetic owner refines two goal titles to reflect newly added requirements. These actions do not assert that the original model names were wrong.', compactAfterTurns: 27, completePreparationAfterTurns: 30 },
    rubric: [
      '30 real logical turns, three separate goal nodes, two native sessions with concurrent submissions; no substituted model response.',
      'All attribution/main/learning jobs commit once; summaries and verifications use actual settled evidence.',
      'Two genuine owner title changes reach improvement diagnosis; edits alone do not establish model error. Review none/personal/report against actual evidence.',
      'Native compaction excludes plugin-owned content; subsequent actual provider node-context blocks and exposed item versions stay within current ancestry.',
      'Authenticated UI read results match stored turns, item versions, summaries and final preparation status.',
      'All actual requests use the original finite ledger; per-turn overhead, tokens, costs and queue timing are retained; this is a development integration episode, not independent value proof.',
    ],
  };
}
