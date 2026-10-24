function __qmux_command_started --on-event fish_preexec
    printf '\e]133;C;cmdline_url=%s\a' (string escape --style=url -- (string sub -l 200 -- $argv[1]))
end

function __qmux_command_finished --on-event fish_postexec
    printf '\e]133;D;%s\a' $status
end
