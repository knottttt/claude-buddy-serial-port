Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

toolsDir = fso.GetParentFolderName(WScript.ScriptFullName)
daemonPath = fso.BuildPath(toolsDir, "buddy_daemon.py")

cmd = "pythonw """ & daemonPath & """ --port auto"
shell.Run cmd, 0, False
