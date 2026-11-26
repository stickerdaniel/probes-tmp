use std::io;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::ptr::{null, null_mut};
use windows_sys::Win32::Security::{
    CreateRestrictedToken, CreateWellKnownSid, ImpersonateLoggedOnUser, RevertToSelf,
    WinBuiltinAdministratorsSid, DISABLE_MAX_PRIVILEGE, SID_AND_ATTRIBUTES, TOKEN_DUPLICATE,
    TOKEN_QUERY,
};
use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

pub struct UserAccess;

impl Drop for UserAccess {
    fn drop(&mut self) {
        unsafe { RevertToSelf() };
    }
}

pub fn current_user_access() -> io::Result<UserAccess> {
    fn checked(result: i32) -> io::Result<()> {
        if result == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    unsafe {
        let mut token = null_mut();
        checked(OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_DUPLICATE | TOKEN_QUERY,
            &mut token,
        ))?;
        let token = OwnedHandle::from_raw_handle(token);

        let mut sid_bytes = [0u32; 17];
        let mut size = std::mem::size_of_val(&sid_bytes) as u32;
        let sid = sid_bytes.as_mut_ptr().cast();
        checked(CreateWellKnownSid(
            WinBuiltinAdministratorsSid,
            null_mut(),
            sid,
            &mut size,
        ))?;

        let administrators = SID_AND_ATTRIBUTES {
            Sid: sid,
            Attributes: 0,
        };
        let mut restricted = null_mut();
        checked(CreateRestrictedToken(
            token.as_raw_handle(),
            DISABLE_MAX_PRIVILEGE,
            1,
            &administrators,
            0,
            null(),
            0,
            null(),
            &mut restricted,
        ))?;
        let restricted = OwnedHandle::from_raw_handle(restricted);
        checked(ImpersonateLoggedOnUser(restricted.as_raw_handle()))?;
    }
    Ok(UserAccess)
}
