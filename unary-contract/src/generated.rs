///`AutostartSetCause`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(transparent)]
pub struct AutostartSetCause(pub ::std::vec::Vec<AutostartSetCauseItem>);
impl ::std::ops::Deref for AutostartSetCause {
    type Target = ::std::vec::Vec<AutostartSetCauseItem>;
    fn deref(&self) -> &::std::vec::Vec<AutostartSetCauseItem> {
        &self.0
    }
}
impl ::std::convert::From<AutostartSetCause> for ::std::vec::Vec<AutostartSetCauseItem> {
    fn from(value: AutostartSetCause) -> Self {
        value.0
    }
}
impl ::std::convert::From<::std::vec::Vec<AutostartSetCauseItem>> for AutostartSetCause {
    fn from(value: ::std::vec::Vec<AutostartSetCauseItem>) -> Self {
        Self(value)
    }
}
///`AutostartSetCauseItem`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(tag = "_tag", deny_unknown_fields)]
pub enum AutostartSetCauseItem {
    Fail { error: AutostartSetCauseItemError },
    Die { defect: ::serde_json::Value },
    Interrupt {
        #[serde(
            rename = "fiberId",
            deserialize_with = "::std::option::Option::deserialize"
        )]
        fiber_id: ::std::option::Option<f64>,
    },
}
///`AutostartSetCauseItemError`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(tag = "_tag", content = "reason")]
pub enum AutostartSetCauseItemError {
    SettingRefused(::std::string::String),
}
///`AutostartSetParams`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct AutostartSetParams {
    pub enabled: bool,
}
///`AutostartSetResult`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct AutostartSetResult {
    pub enabled: bool,
}
///`AutostartShowCause`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(transparent)]
pub struct AutostartShowCause(pub ::std::vec::Vec<AutostartShowCauseItem>);
impl ::std::ops::Deref for AutostartShowCause {
    type Target = ::std::vec::Vec<AutostartShowCauseItem>;
    fn deref(&self) -> &::std::vec::Vec<AutostartShowCauseItem> {
        &self.0
    }
}
impl ::std::convert::From<AutostartShowCause>
for ::std::vec::Vec<AutostartShowCauseItem> {
    fn from(value: AutostartShowCause) -> Self {
        value.0
    }
}
impl ::std::convert::From<::std::vec::Vec<AutostartShowCauseItem>>
for AutostartShowCause {
    fn from(value: ::std::vec::Vec<AutostartShowCauseItem>) -> Self {
        Self(value)
    }
}
///`AutostartShowCauseItem`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(tag = "_tag", deny_unknown_fields)]
pub enum AutostartShowCauseItem {
    Fail { error: AutostartShowCauseItemError },
    Die { defect: ::serde_json::Value },
    Interrupt {
        #[serde(
            rename = "fiberId",
            deserialize_with = "::std::option::Option::deserialize"
        )]
        fiber_id: ::std::option::Option<f64>,
    },
}
///`AutostartShowCauseItemError`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(tag = "_tag", content = "reason")]
pub enum AutostartShowCauseItemError {
    SettingRefused(::std::string::String),
}
///`AutostartShowParams`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(transparent)]
pub struct AutostartShowParams(pub ());
impl ::std::ops::Deref for AutostartShowParams {
    type Target = ();
    fn deref(&self) -> &() {
        &self.0
    }
}
impl ::std::convert::From<AutostartShowParams> for () {
    fn from(value: AutostartShowParams) -> Self {
        value.0
    }
}
impl ::std::convert::From<()> for AutostartShowParams {
    fn from(value: ()) -> Self {
        Self(value)
    }
}
///`AutostartShowResult`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct AutostartShowResult {
    pub enabled: bool,
}
///`SampleNullableCause`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(transparent)]
pub struct SampleNullableCause(pub ::std::vec::Vec<SampleNullableCauseItem>);
impl ::std::ops::Deref for SampleNullableCause {
    type Target = ::std::vec::Vec<SampleNullableCauseItem>;
    fn deref(&self) -> &::std::vec::Vec<SampleNullableCauseItem> {
        &self.0
    }
}
impl ::std::convert::From<SampleNullableCause>
for ::std::vec::Vec<SampleNullableCauseItem> {
    fn from(value: SampleNullableCause) -> Self {
        value.0
    }
}
impl ::std::convert::From<::std::vec::Vec<SampleNullableCauseItem>>
for SampleNullableCause {
    fn from(value: ::std::vec::Vec<SampleNullableCauseItem>) -> Self {
        Self(value)
    }
}
///`SampleNullableCauseItem`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(tag = "_tag", deny_unknown_fields)]
pub enum SampleNullableCauseItem {
    Fail { error: SampleNullableCauseItemError },
    Die { defect: ::serde_json::Value },
    Interrupt {
        #[serde(
            rename = "fiberId",
            deserialize_with = "::std::option::Option::deserialize"
        )]
        fiber_id: ::std::option::Option<f64>,
    },
}
///`SampleNullableCauseItemError`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(tag = "_tag", content = "value")]
pub enum SampleNullableCauseItemError {
    NullableRefused(::std::option::Option<::std::string::String>),
}
impl ::std::convert::From<::std::option::Option<::std::string::String>>
for SampleNullableCauseItemError {
    fn from(value: ::std::option::Option<::std::string::String>) -> Self {
        Self::NullableRefused(value)
    }
}
///`SampleNullableParams`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct SampleNullableParams {
    #[serde(deserialize_with = "::std::option::Option::deserialize")]
    pub value: ::std::option::Option<::std::string::String>,
}
///`SampleNullableResult`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct SampleNullableResult {
    #[serde(deserialize_with = "::std::option::Option::deserialize")]
    pub value: ::std::option::Option<::std::string::String>,
}
///`SampleOptionalCause`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(transparent)]
pub struct SampleOptionalCause(pub ::std::vec::Vec<SampleOptionalCauseItem>);
impl ::std::ops::Deref for SampleOptionalCause {
    type Target = ::std::vec::Vec<SampleOptionalCauseItem>;
    fn deref(&self) -> &::std::vec::Vec<SampleOptionalCauseItem> {
        &self.0
    }
}
impl ::std::convert::From<SampleOptionalCause>
for ::std::vec::Vec<SampleOptionalCauseItem> {
    fn from(value: SampleOptionalCause) -> Self {
        value.0
    }
}
impl ::std::convert::From<::std::vec::Vec<SampleOptionalCauseItem>>
for SampleOptionalCause {
    fn from(value: ::std::vec::Vec<SampleOptionalCauseItem>) -> Self {
        Self(value)
    }
}
///`SampleOptionalCauseItem`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(tag = "_tag", deny_unknown_fields)]
pub enum SampleOptionalCauseItem {
    Fail { error: SampleOptionalCauseItemError },
    Die { defect: ::serde_json::Value },
    Interrupt {
        #[serde(
            rename = "fiberId",
            deserialize_with = "::std::option::Option::deserialize"
        )]
        fiber_id: ::std::option::Option<f64>,
    },
}
///`SampleOptionalCauseItemError`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug)]
#[serde(tag = "_tag", deny_unknown_fields)]
pub enum SampleOptionalCauseItemError {
    OptionalRefused {
        #[serde(skip_serializing_if = "::std::option::Option::is_none")]
        value: ::std::option::Option<::std::string::String>,
    },
}
///`SampleOptionalParams`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug, Default)]
#[serde(deny_unknown_fields)]
pub struct SampleOptionalParams {
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub value: ::std::option::Option<::std::string::String>,
}
///`SampleOptionalResult`
#[derive(::serde::Deserialize, ::serde::Serialize, Clone, Debug, Default)]
#[serde(deny_unknown_fields)]
pub struct SampleOptionalResult {
    #[serde(skip_serializing_if = "::std::option::Option::is_none")]
    pub value: ::std::option::Option<::std::string::String>,
}
