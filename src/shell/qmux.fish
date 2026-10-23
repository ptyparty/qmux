function __qmux_command_started --on-event fish_preexec
    printf '\e]133;C\a'
end

function __qmux_command_finished --on-event fish_postexec
    printf '\e]133;D;%s\a' $status
end
