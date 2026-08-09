// src/initenv/types.ts
// InitEnv 步骤框架的类型定义。
// 独立成文件,避免 index.ts ↔ steps/* 循环 import。

/** 初始化步骤的执行结果 */
export type StepStatus = 'ok' | 'cancelled' | 'failed';

/** InitEnv 的整体结果 */
export type InitResult = 'ok' | 'cancelled' | 'failed';

/** 初始化步骤定义 */
export interface Step {
    /** 步骤标题,用作输出面板分隔线;可以是函数(依赖上下文动态生成) */
    title: string | ((ctx: InitContext) => string);
    /** 已就绪时跳过整步(幂等判断);返回 true 表示无需执行 */
    skipIfDone?: (ctx: InitContext) => boolean;
    /** 跳过时打印到输出面板的说明 */
    skipMessage?: string | ((ctx: InitContext) => string);
    /** 跳过时弹出的信息提示(可选) */
    doneMessage?: string;
    /** 失败时弹出的错误文案;默认用步骤标题 */
    failMessage?: string | ((ctx: InitContext) => string);
    /** false 表示失败不中止流程(提示后继续后续步骤),默认 true */
    fatal?: boolean;
    /** 步骤主逻辑 */
    run: (ctx: InitContext) => Promise<StepStatus>;
}

/** 步骤间共享的上下文 */
export interface InitContext {
    /** Python 可执行文件路径(按平台区分) */
    pyExe: string;
    /** 用户输入的插件名(预收集阶段写入,模板下载/git init 消费) */
    pluginName?: string;
}

/** 一条步骤链:链内步骤串行执行,链与链之间可并行 */
export type StepChain = Step[];
