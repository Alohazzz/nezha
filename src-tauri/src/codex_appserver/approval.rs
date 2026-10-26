//! 审批反向请求的决策校验与应答构造。
//!
//! 阶段 0 实测(findings §4 / D1,高影响):
//! - 0.163 的决策枚举已从旧版 `approved`/`denied` 变更为
//!   `accept / acceptForSession / acceptWithExecpolicyAmendment /
//!   applyNetworkPolicyAmendment / decline / cancel`,误发旧值服务端不报错但
//!   也不生效,必须用新枚举;
//! - `availableDecisions` 是服务端建议的合法决策子集(untrusted 下可能不含
//!   `acceptForSession`/`decline`),UI 与自动应答都以此列表为准;
//! - Nezha 语义映射:拒绝(软拒,turn 继续)→ `decline`;取消任务(硬中断)
//!   → `cancel`。

use codex_app_server_protocol as proto;

/// Nezha 侧的审批动作:UI 三按钮 + 自动拒绝,统一经此映射到协议决策。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalAction {
    /// 批准本次执行。
    Approve,
    /// 软拒绝:不执行该命令,turn 继续。
    Decline,
    /// 硬拒绝:不执行该命令并立即中断 turn(对应「取消任务」)。
    Cancel,
}

impl ApprovalAction {
    /// 映射到 0.163 协议决策枚举(D1)。
    pub fn to_decision(self) -> proto::CommandExecutionApprovalDecision {
        match self {
            ApprovalAction::Approve => proto::CommandExecutionApprovalDecision::Accept,
            ApprovalAction::Decline => proto::CommandExecutionApprovalDecision::Decline,
            ApprovalAction::Cancel => proto::CommandExecutionApprovalDecision::Cancel,
        }
    }
}

/// 校验 `action` 是否在该审批请求的 `availableDecisions` 建议子集内。
///
/// `availableDecisions` 缺省(None)时视为全部动作合法——老样本/实验分支下
/// 服务端可能不带该字段,不能因此把用户锁死。
pub fn is_action_available(
    params: &proto::CommandExecutionRequestApprovalParams,
    action: ApprovalAction,
) -> bool {
    let Some(available) = &params.available_decisions else {
        return true;
    };
    let decision = action.to_decision();
    available.iter().any(|d| d == &decision)
}

/// 构造应答 result(`{"decision": ...}`),配合 `rpc::encode_response` 发回。
pub fn encode_decision_result(
    action: ApprovalAction,
) -> Result<serde_json::Value, serde_json::Error> {
    let response = proto::CommandExecutionRequestApprovalResponse {
        decision: action.to_decision(),
    };
    serde_json::to_value(response)
}

/// 自动拒绝时选用的默认动作:优先 `decline`(软拒,保住 turn 内已完成的
/// 上下文),`decline` 不在建议列表时退到 `cancel`。
pub fn auto_decline_action(
    params: &proto::CommandExecutionRequestApprovalParams,
) -> ApprovalAction {
    if is_action_available(params, ApprovalAction::Decline) {
        ApprovalAction::Decline
    } else {
        ApprovalAction::Cancel
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex_appserver::rpc::{encode_response, parse_frame};
    use codex_app_server_protocol as proto;

    fn sample_params(decisions: Option<Vec<proto::CommandExecutionApprovalDecision>>) -> proto::CommandExecutionRequestApprovalParams {
        serde_json::from_value(serde_json::json!({
            "kind": "command",
            "threadId": "t1",
            "turnId": "turn1",
            "itemId": "item1",
            "startedAtMs": 1,
            "availableDecisions": decisions,
        }))
        .unwrap()
    }

    #[test]
    fn decision_enum_serializes_to_new_wire_names() {
        // D1:0.163 wire 名是 accept/decline/cancel,不再是 approved/denied
        let accept = encode_decision_result(ApprovalAction::Approve).unwrap();
        assert_eq!(accept["decision"], "accept");
        let decline = encode_decision_result(ApprovalAction::Decline).unwrap();
        assert_eq!(decline["decision"], "decline");
        let cancel = encode_decision_result(ApprovalAction::Cancel).unwrap();
        assert_eq!(cancel["decision"], "cancel");
    }

    #[test]
    fn response_frame_roundtrip_matches_probe_shape() {
        // 阶段 0 实测应答:{"id":0,"result":{"decision":"accept"}}
        let id = proto::RequestId::Integer(0);
        let result = encode_decision_result(ApprovalAction::Approve).unwrap();
        let line = encode_response(&id, &result);
        let v: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(v["id"], 0);
        assert_eq!(v["result"]["decision"], "accept");
        // 解析回帧必须是 Response(不是 ServerRequest)
        match parse_frame(line.trim()).unwrap() {
            crate::codex_appserver::rpc::IncomingFrame::Response { id, result, .. } => {
                assert_eq!(id, proto::RequestId::Integer(0));
                assert_eq!(result.unwrap()["decision"], "accept");
            }
            other => panic!("expected response frame, got {other:?}"),
        }
    }

    #[test]
    fn available_decisions_gate_actions() {
        // 阶段 0 实测:untrusted 下建议列表为 [accept, acceptWithExecpolicyAmendment, cancel]
        let params = sample_params(Some(vec![
            proto::CommandExecutionApprovalDecision::Accept,
            proto::CommandExecutionApprovalDecision::Cancel,
        ]));
        assert!(is_action_available(&params, ApprovalAction::Approve));
        assert!(is_action_available(&params, ApprovalAction::Cancel));
        assert!(!is_action_available(&params, ApprovalAction::Decline));
    }

    #[test]
    fn missing_available_decisions_allows_everything() {
        let params = sample_params(None);
        for action in [
            ApprovalAction::Approve,
            ApprovalAction::Decline,
            ApprovalAction::Cancel,
        ] {
            assert!(is_action_available(&params, action));
        }
    }

    #[test]
    fn auto_decline_prefers_decline_falls_back_to_cancel() {
        let with_decline = sample_params(Some(vec![
            proto::CommandExecutionApprovalDecision::Accept,
            proto::CommandExecutionApprovalDecision::Decline,
            proto::CommandExecutionApprovalDecision::Cancel,
        ]));
        assert_eq!(auto_decline_action(&with_decline), ApprovalAction::Decline);

        // 实测 untrusted 分支:无 decline,退 cancel
        let without_decline = sample_params(Some(vec![
            proto::CommandExecutionApprovalDecision::Accept,
            proto::CommandExecutionApprovalDecision::Cancel,
        ]));
        assert_eq!(auto_decline_action(&without_decline), ApprovalAction::Cancel);
    }
}
