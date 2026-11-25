using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using School.Application.Grades;

namespace School.Api.Controllers;

[ApiController]
[Route("api/grades")]
[Authorize(Roles = "Teacher")]
public class GradesController : ControllerBase
{
    private readonly GradeService _grades;

    public GradesController(GradeService grades) => _grades = grades;

    [HttpGet("{submissionId:int}")]
    public async Task<IActionResult> Get(int submissionId, CancellationToken ct)
        => Ok(await _grades.GetAsync(submissionId, User.UserId(), ct));
}
