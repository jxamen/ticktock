; NSIS installer hooks for TickTock.
; Tauri's NSIS template exposes four extensible macros; we wire the service
; install/uninstall commands into them so end-users never run anything by hand.
;
;   NSIS_HOOK_POSTINSTALL    → runs after files are copied / shortcuts created.
;   NSIS_HOOK_PREUNINSTALL   → runs before files are removed on uninstall.
;
; The installer runs elevated (perMachine), so --install-service (which needs
; admin to talk to the SCM) works without any extra UAC prompt.

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "TickTock: registering Windows Service..."
  nsExec::ExecToLog '"$INSTDIR\ticktock-agent.exe" --install-service'
  Pop $0
  ${If} $0 != 0
    DetailPrint "TickTock: --install-service returned $0 (service may already exist)"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "TickTock: stopping and removing service..."
  nsExec::ExecToLog '"$INSTDIR\ticktock-agent.exe" --uninstall-service'
  Pop $0
!macroend
