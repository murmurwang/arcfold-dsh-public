import * as workControl from './goal-work-control.mjs';
import * as methodTool from './method-tool.mjs';
import * as goalTool from './goal-tool.mjs';
import * as goalExecution from './goal-execution-tool.mjs';
import { scopeOf } from '@deepseek-ai/dsh-scope';

export const name = 'arcfold-agent';
export const inject = ['systemPrompt', 'tools', 'agents'];
export function apply(ctx) {
  // Presets are activated before the business service and before an Agent
  // exists. React to the selected service instead of freezing an early read.
  ctx.inject(['arcfoldTreeRuntime'], child => {
    const tree = child.arcfoldTreeRuntime, current = scopeOf(child);
    if (current?.session) return tree.mountMain(child, current);
    child.on('agent/created', async ({ agent }) => {
      if (tree.mainAgents.has(agent.session.id)) return;
      const fiber = await agent.ctx.plugin({
        name: 'arcfold-tree-main-session', inject: ['systemPrompt', 'tools', 'agents'],
        apply(owner) { tree.mountMain(owner, agent); },
      });
      await fiber.await();
      if (fiber.state !== 2) throw new Error('The Arcfold main-session adapter did not activate');
    });
  });
  ctx.inject(['arcfoldBridge', 'arcfoldMethods', 'arcfoldGoals', 'arcfoldWork'], applyLegacy);
}
function applyLegacy(ctx) {
  // This plugin belongs ONLY to the main Arcfold preset. Auxiliary learning
  // sessions use their own preset and cannot recursively enter this pipeline.
  ctx.arcfoldBridge.useNativeRuntime(ctx.root);
  ctx.plugin(methodTool);
  ctx.plugin(goalTool);
  ctx.plugin(goalExecution);
  ctx.plugin(workControl);
  ctx.tools.guard(exec => ctx.arcfoldBridge.nativeContinuationToolDenial(exec));
  ctx.systemPrompt.section({ name: 'arcfold:collaboration', order: 50, interpolate: false,
    text: '你是 Arcfold，帮助用户澄清和推进意图，并让已经完成的共同认识影响后续工作。当前用户原话、纠正与授权优先；个人背景有来源、时间和适用范围，不会扩大工具权限。已有方法先以目录展示；适用时单独调用 arcfold_use_methods，收到完整指导后再行动，不与其他工具同批调用。方法选择只是你对适用性的判断，不证明方法有效，不代表用户确认继续采用。已有长期目标先显示目录；确有关联时单独调用 arcfold_link_goal，读取完整定义与原件后再推进当前委托，说明本次可能的贡献。普通交流不必强行关联目标。暂停或结束追踪的目标，只有用户明确选回后才围绕它讨论，讨论不恢复追踪；对本轮真实用户原话的目标追踪解释由既有后台学习整理，属于可纠正理解，不是新执行授权；用户不必手动管理目标。当前阶段、继续、等待、修改和恢复由 Arcfold 根据真实对话统一决定，DSH 执行获准的具体工作。执行时使用宿主工具，按实际回执报告成果、失败与未知。已有答复不等于长期目标已经达成，助手建议不等于用户决定。宿主执行目标的自动续轮须有 Arcfold 对当前阶段发出的单次许可，程序通知仍不是新用户原话；nativeContinuation 保留最初委托和定义变化的原始引用。标为 native_control、actor unrecorded 的控制只证明宿主目标定义发生变化，不能当成用户新表达、长期目标控制、修复依据或新增工具权限。' });
  ctx.systemPrompt.section({ name: 'arcfold:expression', order: 51, interpolate: false,
    text: `面向用户表达时，保持清楚、简单、顺畅。

围绕当前任务组织内容，用准确、易懂的语言，让每句话都有作用，前后意思自然衔接。

根据任务和用户要求选择合适的详略、语气与形式。简单问题直接回答，复杂问题充分展开，清楚交代必要的依据、条件、步骤和结论的把握程度。

输出前检查：内容是否充分，表达是否精练，阅读是否顺畅。用直接、自然的方式，把意思完整地说清楚。` });
  ctx.on('agent/pre-step', async (payload, next) => {
    await ctx.arcfoldWork.awaitControl(payload.agent);
    const decision = await next();
    if (decision.kind !== 'reject') {
      ctx.arcfoldWork.ownerEntered(payload.agent, decision.messages);
      try { ctx.arcfoldWork.admit(payload.agent, decision.messages, payload.turn); }
      catch { return { kind: 'reject' }; }
    }
    return ctx.arcfoldBridge.prepare(payload, decision);
  });
}
