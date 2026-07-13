#ifndef AppVersion
  #define AppVersion "0.3.0-test"
#endif
#ifndef SourceDir
  #error SourceDir must be provided with /DSourceDir=...
#endif
#ifndef OutputDir
  #error OutputDir must be provided with /DOutputDir=...
#endif

[Setup]
AppId={{A8E80F48-2F3F-4AE8-B9B2-2D5CFAB80891}
AppName=抖音下载管理器
AppVersion={#AppVersion}
AppPublisher=FanHao
DefaultDirName={localappdata}\Programs\DouyinDownloadManager
DefaultGroupName=抖音下载管理器
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename=DouyinDownloadManager-Setup-x64-{#AppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\DouyinDownloadManager.exe

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autodesktop}\抖音下载管理器"; Filename: "{app}\DouyinDownloadManager.exe"; WorkingDir: "{app}"
Name: "{userprograms}\抖音下载管理器"; Filename: "{app}\DouyinDownloadManager.exe"; WorkingDir: "{app}"

[Run]
Filename: "{app}\DouyinDownloadManager.exe"; Description: "启动抖音下载管理器"; Flags: nowait postinstall skipifsilent
