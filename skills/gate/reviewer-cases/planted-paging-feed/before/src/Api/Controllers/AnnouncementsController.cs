using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using School.Application.Announcements;

namespace School.Api.Controllers;

[ApiController]
[Route("api/announcements")]
[Authorize]
public class AnnouncementsController : ControllerBase
{
    private readonly AnnouncementService _announcements;

    public AnnouncementsController(AnnouncementService announcements) => _announcements = announcements;

    [HttpGet("latest")]
    public async Task<IActionResult> Latest(CancellationToken ct)
        => Ok(await _announcements.LatestAsync(User.SchoolId(), ct));
}
